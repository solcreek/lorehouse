package main

import (
	"strings"
	"testing"
)

func TestAnExecBodyIsReadByItsExactKeysOnly(t *testing.T) {
	req, err := decodeExec(strings.NewReader(`{"command":"make","cwd":"/w","env":{"A":"b"},"timeoutMs":60000}`))
	if err != nil {
		t.Fatal(err)
	}
	if req.Command != "make" || req.Cwd != "/w" || req.Env["A"] != "b" || req.TimeoutMs != 60000 {
		t.Fatalf("got %+v", req)
	}
	if req, err := decodeExec(strings.NewReader(`{"command":"make"}`)); err != nil || req.TimeoutMs != 0 {
		t.Fatalf("command alone: %+v, %v", req, err)
	}
	// What encoding/json would have taken for timeoutMs after the host's capped one,
	// the last winning: another case, the long s that folds to s, the key twice.
	for _, body := range []string{
		`{"command":"sleep 86400","timeoutMs":60000,"timeoutms":86400000}`,
		`{"command":"sleep 86400","timeoutMs":60000,"TIMEOUTMS":86400000}`,
		`{"command":"sleep 86400","timeoutMs":60000,"TimeoutMs":86400000}`,
		`{"command":"sleep 86400","timeoutMs":60000,"timeoutMſ":86400000}`,
		`{"command":"sleep 86400","timeoutMs":60000,"timeoutMs":86400000}`,
		`{"command":"sleep 86400","timeoutms":86400000}`,
		`{"Command":"sleep 86400"}`,
		`{"command":"true","command":"sleep 86400"}`,
		`{"command":"make","extra":1}`,
	} {
		if req, err := decodeExec(strings.NewReader(body)); err == nil {
			t.Fatalf("%s was read as %+v", body, req)
		}
	}
	// Not one JSON object, bytes that aren't UTF-8 (Go would repair them and run it),
	// a wrong type, no command.
	for _, body := range []string{
		``, `null`, `["make"]`, `"make"`, `{"command":"make"`, `{"command":"make"} {"timeoutMs":86400000}`,
		"{\"command\":\"sleep 86400 #\xff\xfe\",\"timeoutMs\":86400000}",
		`{"command":"make","timeoutMs":"forever"}`, `{"command":"make","timeoutMs":1.5}`, `{"command":7}`, `{"cwd":"/w"}`, `{"command":""}`,
	} {
		if req, err := decodeExec(strings.NewReader(body)); err == nil {
			t.Fatalf("%q was read as %+v", body, req)
		}
	}
}

func TestTailBufferKeepsEverythingUnderTheLimit(t *testing.T) {
	var b tailBuffer
	b.Write([]byte("hello "))
	b.Write([]byte("world"))
	if got := b.String(); got != "hello world" {
		t.Fatalf("got %q", got)
	}
}

func TestTailBufferKeepsTheTailAndSaysWhatItDropped(t *testing.T) {
	var b tailBuffer
	chunk := []byte(strings.Repeat("x", 1<<20))
	for i := 0; i < 6; i++ { // 6 MiB into a 4 MiB tail
		b.Write(chunk)
	}
	b.Write([]byte("FAILED: 2 tests"))
	got := b.String()
	if !strings.HasSuffix(got, "FAILED: 2 tests") {
		t.Fatal("the tail was lost")
	}
	if !strings.HasPrefix(got, "[guestd: 2097167 earlier bytes dropped]\n") {
		t.Fatalf("marker: %q", got[:60])
	}
	if len(b.buf) != maxOutput {
		t.Fatalf("kept %d bytes, want %d", len(b.buf), maxOutput)
	}
}
