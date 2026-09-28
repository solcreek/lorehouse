package main

import (
	"strings"
	"testing"
)

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
