#!/usr/bin/env python3
"""Benchmarks for a lab sandboxd in serve mode. Runs as root on the lab host, which is
where the API token file lives; lab.sh copies it there and runs it.

  bench.py cold [n]       n cold boots one after another (a new sandbox, exec `true`)
  bench.py burst n        n new sandboxes booted at once
  bench.py stagger n gap  n boots, one every gap seconds
  bench.py work           one sandbox: clone + npm install, clone + go build, CPU, disk
  bench.py workpar n      n sandboxes running clone + npm install at once
  bench.py cpupar n       n sandboxes running `go build -a` at the same moment (no network)
  bench.py clean          delete every sandbox

Each command prints readable lines, then one JSON line, the last line of its output:
{"bench": ..., "ok": n, "failed": n, "p50": s, "p95": s, "max": s, ...}.
"""
import base64, json, os, sys, threading, time, urllib.error, urllib.request

TOKEN = open("/etc/lorehouse/sandboxd-api-token").read().strip()
BASE = "http://127.0.0.1:8787/v1/sandboxes"
RUN = str(int(time.time()))
# On a network that blocks outside DNS (a LAN that allows only its own resolver), pin the
# few hosts the workloads need: lines of "<ip> <name>" in this file are appended to the
# guest's /etc/hosts. The cloud lab doesn't need it.
HOSTS = "/etc/lorehouse/lab-hosts"
PRE = (f"echo {base64.b64encode(open(HOSTS, 'rb').read()).decode()} | base64 -d >> /etc/hosts"
       if os.path.exists(HOSTS) else "true")
GOENV = "export HOME=/root GOPATH=/root/go GOCACHE=/root/.cache/go-build GOFLAGS=-buildvcs=false"
NPM = ("rm -rf ex && git clone -q --depth 1 https://github.com/expressjs/express ex && cd ex"
       " && npm install --no-audit --no-fund --silent >/dev/null")
GO = f"{GOENV} && rm -rf cb && git clone -q --depth 1 https://github.com/spf13/cobra cb && cd cb && go build ./..."


def req(method, path, body=None, timeout=900):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read()
            return json.loads(raw) if raw and resp.headers.get_content_type() == "application/json" else raw
    except urllib.error.HTTPError as e:
        # sandboxd's error body says what went wrong (e.g. a boot failure and its console log).
        raise RuntimeError(f"{method} {path}: {e.code} {e.read().decode(errors='replace')[:300]}") from None


def exec_(sid, cmd, timeout_ms=600_000):
    t = time.time()
    out = req("POST", f"/{sid}/exec", {"command": cmd, "cwd": "/workspace", "timeoutMs": timeout_ms})
    return time.time() - t, out


def ok(out):
    return isinstance(out, dict) and out.get("exitCode") == 0


def host_mem_gib():
    m = {k: int(v.split()[0]) / 1048576 for k, v in (l.split(":", 1) for l in open("/proc/meminfo"))}
    return round(m["MemTotal"] - m["MemAvailable"], 1), round(m["MemTotal"], 1)


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


def report(bench, xs, errors, **extra):
    used, total = host_mem_gib()
    line = {"bench": bench, "ok": len(xs), "failed": len(errors), **extra, "host_mem_used_gib": used, "host_mem_gib": total}
    if xs:
        line.update(p50=round(pct(xs, 50), 2), p95=round(pct(xs, 95), 2), max=round(max(xs), 2))
        print(f"{bench}: {len(xs)} ok, {len(errors)} failed | p50 {line['p50']}s p95 {line['p95']}s max {line['max']}s")
    else:
        print(f"{bench}: all {len(errors)} failed")
    for e in sorted(set(errors))[:3]:
        print("  error:", e)
    if errors:
        line["errors"] = sorted(set(errors))[:3]
    print(json.dumps(line))


def parallel(n, one, gap=0.0):
    """Run one(i) for i in range(n) on threads; results and errors are collected by one."""
    threads = []
    t0 = time.time()
    for i in range(n):
        t = threading.Thread(target=one, args=(i,))
        t.start()
        threads.append(t)
        if gap:
            time.sleep(gap)
    for t in threads:
        t.join()
    return round(time.time() - t0, 1)


def boots(name, n, gap=0.0):
    res, errs = [], []
    def one(i):
        try:
            dt, _ = exec_(f"{name}-{RUN}-{i}", "true")
            res.append(dt)
        except Exception as e:
            errs.append(str(e)[:200])
    wall = parallel(n, one, gap)
    report(f"{name} {n}" + (f" every {gap}s" if gap else ""), res, errs, wall_s=wall)


def cold(n):
    res, errs, warm = [], [], []
    for i in range(n):
        sid = f"cold-{RUN}-{i}"
        try:
            dt, _ = exec_(sid, "true")
            dt2, _ = exec_(sid, "true")
            res.append(dt); warm.append(dt2)
            print(f"  cold {i}: first exec {dt:.2f}s, second exec {dt2 * 1000:.0f} ms")
        except Exception as e:
            errs.append(str(e)[:200])
    report(f"cold {n}", res, errs, warm_exec_ms=round(1000 * pct(warm, 50)) if warm else None)


def work():
    sid = f"work-{RUN}"
    steps = [("boot", PRE),
             ("clone express", "rm -rf ex0 && git clone -q --depth 1 https://github.com/expressjs/express ex0"),
             ("npm install (cold cache)", "cd ex0 && npm install --no-audit --no-fund --silent >/dev/null"),
             ("clone + go build cobra (cold cache)", GO),
             ("go build again (warm)", f"{GOENV} && cd cb && go build ./..."),
             ("cpu: sha256 of 1 GiB", "head -c 1G /dev/zero | sha256sum >/dev/null"),
             ("disk: write 1 GiB, fsync", "dd if=/dev/zero of=/workspace/f bs=1M count=1024 conv=fsync status=none && rm /workspace/f")]
    times, errs = {}, []
    for label, cmd in steps:
        try:
            dt, out = exec_(sid, cmd)
        except Exception as e:
            dt, out = 0.0, {"stderr": str(e)}
        times[label] = round(dt, 1)
        print(f"  {label}: {dt:.1f}s {'ok' if ok(out) else 'FAILED ' + str(out)[:300]}")
        if not ok(out):
            errs.append(label)
            if label == "boot":
                break  # nothing else can run without a VM
    print(json.dumps({"bench": "work", "steps_s": times, "failed": errs}))


def workpar(n):
    res, errs = [], []
    def one(i):
        sid = f"par-{RUN}-{i}"
        try:
            exec_(sid, PRE)
            dt, out = exec_(sid, NPM)
            (res.append(dt) if ok(out) else errs.append(str(out)[:200]))
        except Exception as e:
            errs.append(str(e)[:200])
    wall = parallel(n, one)
    report(f"workpar {n}", res, errs, wall_s=wall)


def cpupar(n):
    """n sandboxes fetch cobra and its modules, then all run `go build -a` at once."""
    prep = f"{GOENV} && rm -rf cb && git clone -q --depth 1 https://github.com/spf13/cobra cb && cd cb && go mod download"
    build = f"{GOENV} && cd cb && go build -a ./..."
    barrier = threading.Barrier(n)
    res, errs = [], []
    def one(i):
        sid = f"cpu-{RUN}-{i}"
        try:
            exec_(sid, PRE)
            _, o = exec_(sid, prep)
            ready = ok(o)
        except Exception as e:
            ready, o = False, str(e)
        barrier.wait()
        if not ready:
            errs.append(f"prep: {str(o)[:200]}")
            return
        dt, o = exec_(sid, build)
        (res.append(dt) if ok(o) else errs.append(str(o)[:200]))
    parallel(n, one)
    report(f"cpupar {n}", res, errs)


def clean():
    lst = req("GET", "")
    items = lst if isinstance(lst, list) else lst.get("sandboxes", [])
    ids = [x["id"] if isinstance(x, dict) else x for x in items]
    errs = []
    def one(i):
        try:
            req("DELETE", f"/{ids[i]}")
        except Exception as e:
            errs.append(str(e)[:200])
    parallel(len(ids), one)
    used, total = host_mem_gib()
    print(json.dumps({"bench": "clean", "deleted": len(ids) - len(errs), "failed": len(errs), "host_mem_used_gib": used}))


if __name__ == "__main__":
    cmd, *a = sys.argv[1:] or ["help"]
    commands = {
        "cold": lambda: cold(int(a[0]) if a else 5),
        "burst": lambda: boots("burst", int(a[0])),
        "stagger": lambda: boots("stagger", int(a[0]), float(a[1])),
        "work": work,
        "workpar": lambda: workpar(int(a[0])),
        "cpupar": lambda: cpupar(int(a[0])),
        "clean": clean,
    }
    if cmd not in commands:
        sys.exit(__doc__)
    commands[cmd]()
