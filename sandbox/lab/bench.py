#!/usr/bin/env python3
"""Benchmarks for a lab sandboxd in serve mode. Runs as root on the lab host, which is
where the API token file lives; lab.sh copies it there and runs it.

  bench.py cold [n]       n cold boots one after another (a new sandbox, exec `true`)
  bench.py burst n        n new sandboxes booted at once
  bench.py stagger n gap  n boots, one every gap seconds
  bench.py work           one sandbox: clone + npm install, clone + go build, CPU, disk
  bench.py workpar n      n sandboxes running clone + npm install at once
  bench.py cpupar n       n sandboxes running `go build -a` at the same moment (no network)
  bench.py limits         two sandboxes, one with the host's defaults and one with a request:
                          vCPUs, memory, pids, disk and command timeout observed in each, and
                          the refusals (needs LAB_FS=btrfs and raised SANDBOXD_MAX_*; exits 1
                          when a check fails)
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
        if gap and i < n - 1:  # between launches only, so wall_s isn't padded by a last gap
            time.sleep(gap)
    for t in threads:
        t.join()
    return round(time.time() - t0, 1)


def boots(name, n, gap=0.0):
    res, errs = [], []
    def one(i):
        try:
            dt, out = exec_(f"{name}-{RUN}-{i}", "true")
            # A guest failure or timeout is a 200 with a nonzero exitCode: not a sample.
            (res.append(dt) if ok(out) else errs.append(f"exec: {str(out)[:200]}"))
        except Exception as e:
            errs.append(str(e)[:200])
    wall = parallel(n, one, gap)
    report(f"{name} {n}" + (f" every {gap}s" if gap else ""), res, errs, wall_s=wall)


def cold(n):
    res, errs, warm = [], [], []
    for i in range(n):
        sid = f"cold-{RUN}-{i}"
        try:
            dt, out = exec_(sid, "true")
            dt2, out2 = exec_(sid, "true")
            if not (ok(out) and ok(out2)):
                errs.append(f"exec: {str(out if not ok(out) else out2)[:200]}")
                continue
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
        try:
            dt, o = exec_(sid, build)
        except Exception as e:  # a thread's exception never reaches join(): record it
            errs.append(f"build: {str(e)[:200]}")
            return
        (res.append(dt) if ok(o) else errs.append(f"build: {str(o)[:200]}"))
    parallel(n, one)
    report(f"cpupar {n}", res, errs)


def call(method, url, body=None, headers=None, timeout=900, raw=None):
    """Like req, for any URL and with extra headers; a refusal is an answer: (status, body).
    `raw`: the body's bytes as they are, for one json.dumps wouldn't write."""
    data = raw if raw is not None else json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw.decode(errors="replace")


def limits():
    """Each of a sandbox's limits (#109), observed on two sandboxes of one host: A made with
    no request (the host's defaults), B with a request for the host's maxima and a 20 s
    command timeout. Needs maxima above the defaults, and a disk quota (LAB_FS=btrfs):
      LAB_SANDBOXD="SANDBOXD_MAX_VCPUS=4 SANDBOXD_MAX_MEM_MIB=4096 SANDBOXD_MAX_DISK_GIB=4
                    SANDBOXD_MAX_PIDS=128 SANDBOXD_MAX_COMMAND_TIMEOUT_SECS=900"
    Also: a request over a maximum, a malformed one, and another request for B while it
    runs are refused, each with its code, and B's own request again is not; an exec body
    that tries to choose its own timeout is refused or cut to the sandbox's; and a stopped
    sandbox takes its next request's resources (less disk than it holds is refused).
    With SANDBOXD_IDLE_SECS at 30 or less (LAB_SANDBOXD), also: refused requests don't keep
    a VM from its idle stop, after which the sandbox takes the request."""
    root = BASE.rsplit("/sandboxes", 1)[0]
    status, caps = call("GET", f"{root}/capabilities")
    if status != 200 or "resources" not in (caps.get("features") or []):
        print(json.dumps({"bench": "limits", "ok": False, "error": f"this sandboxd has no resources feature (GET /v1/capabilities: {status})"}))
        sys.exit(1)
    d, m = caps["resources"]["defaults"], caps["resources"]["maxima"]
    same = [f for f in ("vcpus", "memMib", "diskGib", "pids") if not m.get(f) or not d.get(f) or m[f] <= d[f]]
    if same or d["commandTimeoutSecs"] < 120:
        print(json.dumps({"bench": "limits", "ok": False, "defaults": d, "maxima": m,
                          "error": f"nothing to tell apart for {', '.join(same) or 'commandTimeoutSecs'}: deploy with LAB_FS=btrfs and LAB_SANDBOXD raising each SANDBOXD_MAX_* above its default (see bench.py limits)"}))
        sys.exit(1)
    env = dict(l.strip().split("=", 1) for l in open("/etc/lorehouse/sandboxd.env") if "=" in l)
    state = env["SANDBOXD_STATE"]
    ask = {"vcpus": m["vcpus"], "memMib": m["memMib"], "diskGib": m["diskGib"], "pids": m["pids"], "commandTimeoutSecs": 20}
    H = "X-Lorehouse-Sandbox-Resources"
    a, b = f"limits-a-{RUN}", f"limits-b-{RUN}"
    # What each sandbox should have: A the defaults, B what it asked for.
    want = {a: d, b: {**d, **ask}}
    # The request each sandbox's calls carry: none for A, B's own.
    hdrs = {b: {H: json.dumps(ask)}}
    checks = []

    code_of = lambda out: out.get("code") if isinstance(out, dict) else None

    def check(name, got, expected, passed):
        checks.append({"check": name, "got": got, "want": expected, "ok": bool(passed)})
        print(f"  {'ok  ' if passed else 'FAIL'} {name}: got {got}, want {expected}")

    def run(sid, cmd, timeout_ms=600_000):
        t = time.time()
        status, out = call("POST", f"{BASE}/{sid}/exec", {"command": cmd, "cwd": "/workspace", "timeoutMs": timeout_ms}, hdrs.get(sid))
        return status, out, time.time() - t

    def cgroup(sid, name):
        # The VM's cgroup is its slot's: the jail directory names the slot while the VM runs.
        jails = [p for p in os.listdir(f"{state}/{sid}/jail/firecracker") if p.startswith("lorehouse-")]
        return open(f"/sys/fs/cgroup/system.slice/sandboxd.service/vms/{jails[0]}/{name}").read().strip()

    try:
        # Refused before anything is made: over a maximum, and malformed.
        over = f"limits-over-{RUN}"
        status, out = call("POST", f"{BASE}/{over}/exec", {"command": "true", "cwd": "/", "timeoutMs": 60_000},
                           {H: json.dumps({"memMib": m["memMib"] * 2})})
        check("a request over a maximum is refused", [status, out.get("code") if isinstance(out, dict) else out], [422, "resource_over_maximum"],
              status == 422 and isinstance(out, dict) and out.get("code") == "resource_over_maximum")
        check("and makes no sandbox", os.path.exists(f"{state}/{over}"), False, not os.path.exists(f"{state}/{over}"))
        status, out = call("POST", f"{BASE}/limits-bad-{RUN}/exec", {"command": "true", "cwd": "/", "timeoutMs": 60_000},
                           {H: json.dumps({"vcpus": 0})})
        check("a malformed request is refused", [status, out.get("code") if isinstance(out, dict) else out], [400, "invalid_resources"],
              status == 400 and isinstance(out, dict) and out.get("code") == "invalid_resources")

        for sid in (a, b):
            status, out, _ = run(sid, "nproc; grep MemTotal /proc/meminfo")
            if status != 200 or not ok(out):
                check(f"{sid} boots", [status, str(out)[:300]], "exit 0", False)
                raise RuntimeError("a sandbox did not boot")
            cpus, mem_kb = int(out["stdout"].split()[0]), int(out["stdout"].split()[2])
            w = want[sid]
            check(f"{sid} vCPUs in the guest (nproc)", cpus, w["vcpus"], cpus == w["vcpus"])
            # The guest kernel keeps some of its RAM for itself: a little under the grant.
            check(f"{sid} memory in the guest (MemTotal, MiB)", mem_kb // 1024, f"{int(w['memMib'] * 0.9)}..{w['memMib']}", w["memMib"] * 0.9 <= mem_kb / 1024 <= w["memMib"])
            check(f"{sid} cpu.max on the host", cgroup(sid, "cpu.max"), f"{(w['vcpus'] + 1) * 100000} 100000", cgroup(sid, "cpu.max") == f"{(w['vcpus'] + 1) * 100000} 100000")
            check(f"{sid} pids.max on the host", cgroup(sid, "pids.max"), str(w["pids"]), cgroup(sid, "pids.max") == str(w["pids"]))
        # memory.max is the VM's RAM plus the same headroom for both: they differ by the RAM.
        gap = (int(cgroup(b, "memory.max")) - int(cgroup(a, "memory.max"))) // (1 << 20)
        check("memory.max on the host, B over A (MiB)", gap, ask["memMib"] - d["memMib"], gap == ask["memMib"] - d["memMib"])
        listed = {x["id"]: x.get("resources") for x in call("GET", BASE)[1]}
        check("GET /v1/sandboxes names what each runs with", [listed.get(a), listed.get(b)], [want[a], want[b]], listed.get(a) == want[a] and listed.get(b) == want[b])

        # Another request for B is refused; its own again is fine.
        status, out = call("POST", f"{BASE}/{b}/exec", {"command": "true", "cwd": "/", "timeoutMs": 60_000},
                           {H: json.dumps({"vcpus": d["vcpus"]})})
        check("another request for B is refused", [status, out.get("code") if isinstance(out, dict) else out], [409, "resources_mismatch"],
              status == 409 and isinstance(out, dict) and out.get("code") == "resources_mismatch")
        status, out, _ = run(b, "true")
        check("B's own request again runs", [status, out.get("exitCode") if isinstance(out, dict) else out], [200, 0], status == 200 and ok(out))

        # A job B started keeps running when its profile's request changes: calls carrying
        # another request may still read its status, read a file and cancel it. (That an exec
        # is refused is the check above.)
        job, other = f"hold-{RUN}", {H: json.dumps({"vcpus": d["vcpus"]})}
        status, out = call("POST", f"{BASE}/{b}/jobs", {"id": job, "command": "sleep 120", "cwd": "/workspace", "timeoutMs": 600_000}, hdrs[b])
        check("B starts a background job", [status, out.get("state") if isinstance(out, dict) else str(out)[:200]], "200 or 201", status in (200, 201))
        status, out = call("GET", f"{BASE}/{b}/jobs/{job}?waitMs=0&tailBytes=1024", None, other)
        check("another request may read the job's status", [status, out.get("state") if isinstance(out, dict) else str(out)[:200]], [200, "running"],
              status == 200 and isinstance(out, dict) and out.get("state") == "running")
        status, out = call("GET", f"{BASE}/{b}/file?path=/etc/hostname", None, other)
        check("and read a file", status, 200, status == 200)
        status, out = call("POST", f"{BASE}/{b}/jobs/{job}/cancel", None, other)
        check("and cancel the job", [status, out.get("state") if isinstance(out, dict) else str(out)[:200]], [200, "cancelled"],
              status == 200 and isinstance(out, dict) and out.get("state") == "cancelled")
        listed = {x["id"]: x for x in call("GET", BASE)[1]}
        check("B still runs with what it was made with", [listed.get(b, {}).get("running"), listed.get(b, {}).get("resources")], [True, want[b]],
              listed.get(b, {}).get("running") is True and listed.get(b, {}).get("resources") == want[b])

        # An exec body that is refused touches nothing: no sandbox is made for it, and it
        # is not activity in one that runs.
        nobody = f"limits-body-{RUN}"
        t0 = time.time()
        status, out = call("POST", f"{BASE}/{nobody}/exec", {"command": "true", "timeoutms": 86_400_000}, {H: json.dumps({"commandTimeoutSecs": 60})})
        check("a refused body makes no sandbox", [status, code_of(out), os.path.exists(f"{state}/{nobody}"), nobody in {x["id"] for x in call("GET", BASE)[1]}, round(time.time() - t0)],
              [400, "invalid_exec_body", False, False, "0..1"],
              status == 400 and code_of(out) == "invalid_exec_body" and not os.path.exists(f"{state}/{nobody}") and nobody not in {x["id"] for x in call("GET", BASE)[1]} and time.time() - t0 < 2)
        idle0 = {x["id"]: x for x in call("GET", BASE)[1]}[b]["idle_secs"]
        time.sleep(3)
        call("POST", f"{BASE}/{b}/exec", {"command": "true", "timeoutms": 86_400_000}, hdrs[b])
        idle1 = {x["id"]: x for x in call("GET", BASE)[1]}[b]["idle_secs"]
        check("and is not activity in B (idle seconds before, after)", [idle0, idle1], "after at least 2 more", idle1 >= idle0 + 2)

        # The command timeout: both are asked to wait 600 s for a 45 s sleep.
        slept = {}
        def sleep(i):
            sid = (a, b)[i]
            slept[sid] = run(sid, "sleep 45")
        parallel(2, sleep)
        _, out, dt = slept[a]
        check("A's command runs its 45 s (limit 600 s)", [out.get("exitCode") if isinstance(out, dict) else out, round(dt)], [0, "45..50"], ok(out) and 44 <= dt <= 50)
        _, out, dt = slept[b]
        check("B's command is stopped at its 20 s", [out.get("exitCode") if isinstance(out, dict) else out, round(dt)], [124, "20..25"],
              isinstance(out, dict) and out.get("exitCode") == 124 and 19 <= dt <= 25)

        # An exec body can't choose its own timeout (B's is 20 s). A second spelling of the
        # key, and a body one JSON reader refuses and another accepts, are refused outright;
        # a query on the path changes nothing.
        t0 = time.time()
        status, out = call("POST", f"{BASE}/{b}/exec", {"command": "sleep 45", "cwd": "/workspace", "timeoutMs": 600_000, "timeoutms": 86_400_000}, hdrs[b])
        check("a second spelling of timeoutMs is refused, at once", [status, code_of(out), round(time.time() - t0)], [400, "invalid_exec_body", "0..2"],
              status == 400 and code_of(out) == "invalid_exec_body" and time.time() - t0 < 3)
        status, out = call("POST", f"{BASE}/{b}/exec", None, hdrs[b], raw=b'{"command":"sleep 45 #\\ud800","timeoutMs":86400000}')
        check("a body with half a character is refused", [status, code_of(out)], [400, "invalid_exec_body"], status == 400 and code_of(out) == "invalid_exec_body")
        t0 = time.time()
        status, out = call("POST", f"{BASE}/{b}/exec?x=1", {"command": "sleep 45", "cwd": "/workspace", "timeoutMs": 86_400_000}, hdrs[b])
        dt = time.time() - t0
        check("a query on the path doesn't lift B's 20 s", [status, out.get("exitCode") if isinstance(out, dict) else out, round(dt)], "400, or [200, 124, 20..25]",
              status == 400 or (status == 200 and isinstance(out, dict) and out.get("exitCode") == 124 and 19 <= dt <= 25))

        BOOT_ID = "cat /proc/sys/kernel/random/boot_id"

        def reboot(sid):
            # sandboxd has no call that stops a VM and keeps its disk: the guest reboots
            # itself, which ends the VM (the kernel runs with reboot=k). The listing goes on
            # saying it runs until the next request or the idle reaper finds out, so what is
            # observed is the next request's boot: another boot id than this one.
            status, out, _ = run(sid, BOOT_ID)
            if not (isinstance(out, dict) and (out.get("stdout") or "").strip()):
                print(f"  note: {sid} gave no boot id before its reboot: {status} {str(out)[:400]}")
            run(sid, "sync; (sleep 0.5; reboot -f) >/dev/null 2>&1 &")
            time.sleep(3)
            return (out.get("stdout") or "").strip() if isinstance(out, dict) else None

        def qgroup_limit(sid):
            for line in os.popen(f"btrfs qgroup show -re --raw {state}").read().splitlines():
                f = line.split()
                if len(f) >= 6 and f[0].startswith("0/") and os.path.basename(f[5]) == sid:
                    return f[4]

        # A stopped sandbox takes its next request: B comes back with the defaults, the
        # most disk, and a 30 s command timeout.
        was = reboot(b)
        ask2 = {"vcpus": d["vcpus"], "memMib": d["memMib"], "diskGib": m["diskGib"], "pids": d["pids"], "commandTimeoutSecs": 30}
        hdrs[b], want[b] = {H: json.dumps(ask2)}, ask2
        status, out, _ = run(b, f"nproc; grep MemTotal /proc/meminfo; {BOOT_ID}")
        if status != 200 or not ok(out):
            check("B boots with its new request", [status, str(out)[:300]], "exit 0", False)
            raise RuntimeError("B did not boot with its new request")
        cpus, mem_kb = int(out["stdout"].split()[0]), int(out["stdout"].split()[2])
        check("B's guest rebooted, and this is a new boot", [was, out["stdout"].split()[-1]], "two boot ids", bool(was) and out["stdout"].split()[-1] != was)
        check("B after its new request: vCPUs, MemTotal (MiB), cpu.max, pids.max", [cpus, mem_kb // 1024, cgroup(b, "cpu.max"), cgroup(b, "pids.max")],
              [ask2["vcpus"], f"..{ask2['memMib']}", f"{(ask2['vcpus'] + 1) * 100000} 100000", str(ask2["pids"])],
              cpus == ask2["vcpus"] and ask2["memMib"] * 0.9 <= mem_kb / 1024 <= ask2["memMib"] and cgroup(b, "cpu.max") == f"{(ask2['vcpus'] + 1) * 100000} 100000" and cgroup(b, "pids.max") == str(ask2["pids"]))
        stored = json.load(open(f"{state}/{b}/resources.json"))
        check("B's record on the host is the new request", stored, ask2, all(stored.get(k) == v for k, v in ask2.items()))
        logged = os.popen(f"journalctl -u sandboxd --since '-15 min' -o cat | grep -c '{b}: resources changed from'").read().strip()
        check("sandboxd logged the change", logged, "1 or more", logged.isdigit() and int(logged) >= 1)
        _, out, dt = run(b, "sleep 45")
        check("B's command is now stopped at 30 s", [out.get("exitCode") if isinstance(out, dict) else out, round(dt)], [124, "30..35"],
              isinstance(out, dict) and out.get("exitCode") == 124 and 29 <= dt <= 35)

        # The disk, last: a guest that fills its disk may be left with a read-only root.
        # Direct IO, since a buffered write reports success and fails later, at writeback.
        qg = {}
        for line in os.popen(f"btrfs qgroup show -re --raw {state}").read().splitlines():
            f = line.split()
            if len(f) >= 6 and f[0].startswith("0/"):
                qg[os.path.basename(f[5])] = f[4]
        for sid in (a, b):
            cap = want[sid]["diskGib"]
            check(f"{sid} qgroup limit on the host (bytes)", qg.get(sid), str(cap << 30), qg.get(sid) == str(cap << 30))
            # 256 MiB appended per command, so each fits B's 20 s even at the lab disk's
            # sustained rate (about 36 MB/s, 2026-11-18): until one fails, or 1 GiB past the cap.
            code, wrote = "0", -1
            for _ in range((cap + 1) * 4):
                _, out, _ = run(sid, "dd if=/dev/zero of=/workspace/big bs=1M count=256 oflag=direct,append conv=notrunc status=none; echo dd=$?; stat -c %s /workspace/big")
                words = (out.get("stdout") or "").split() if isinstance(out, dict) else []
                code = next((w[3:] for w in words if w.startswith("dd=")), f"exec {out.get('exitCode') if isinstance(out, dict) else out}")
                wrote = int(words[-1]) // (1 << 20) if words and words[-1].isdigit() else wrote
                if code != "0":
                    break
            # Its own earlier writes count too, so it stops a little short of the cap.
            check(f"{sid} writes of 256 MiB stop at its {cap} GiB (MiB written, the last dd's exit)", [wrote, code], [f"{cap * 1024 - 400}..{cap * 1024}", "1"],
                  cap * 1024 - 400 <= wrote <= cap * 1024 and code == "1")
        # B holds nearly all of its disk now: stopped, a request for 1 GiB is refused, and
        # its limit stays. A, made with no request, is stopped and asks for more disk: the
        # sandbox of a thread that began before its profile asked for anything.
        # (Were B still running, the answer would be 409 resources_mismatch.)
        reboot(b)
        before = qgroup_limit(b)
        status, out = call("POST", f"{BASE}/{b}/exec", {"command": "true", "cwd": "/", "timeoutMs": 60_000}, {H: json.dumps({**ask2, "diskGib": 1})})
        used = out.get("usedBytes") if isinstance(out, dict) else None
        check("less disk than B holds is refused", [status, code_of(out), used], [422, "disk_in_use", "over 1 GiB"],
              status == 422 and code_of(out) == "disk_in_use" and isinstance(used, int) and used > 1 << 30)
        check("and B's limit on the host is as it was", qgroup_limit(b), before, qgroup_limit(b) == before)
        reboot(a)
        # A is full and stopped. Seen 2026-11-18: a sandbox at its disk's cap doesn't boot
        # again as it is (500, "the jailer or firecracker exited during boot"). Printed, not
        # judged: it is how sandboxd was before #109, and growing the disk is the way out.
        status, out, _ = run(a, "true")
        print(f"  note: A, full and stopped, asking for nothing: {status} {str(out)[:160]}")
        if status == 200:
            reboot(a)
        hdrs[a] = {H: json.dumps({"diskGib": m["diskGib"]})}
        status, out, _ = run(a, "true")
        check("A, made with no request, takes one once stopped", [status, out.get("exitCode") if isinstance(out, dict) else str(out)[:200]], [200, 0], status == 200 and ok(out))
        check("A's limit on the host grew (bytes)", qgroup_limit(a), str(m["diskGib"] << 30), qgroup_limit(a) == str(m["diskGib"] << 30))

        # Refused requests are not activity: a running sandbox asked for other resources
        # every 5 s still stops when idle, and then takes the request.
        idle = int(env.get("SANDBOXD_IDLE_SECS", "900"))
        if idle <= 30:
            c = f"limits-c-{RUN}"
            call("POST", f"{BASE}/{c}/exec", {"command": "true", "cwd": "/", "timeoutMs": 60_000})
            other = {H: json.dumps({"vcpus": m["vcpus"]})}
            t0, codes, took = time.time(), set(), None
            while time.time() - t0 < idle + 75:
                status, out = call("POST", f"{BASE}/{c}/exec", {"command": "nproc", "cwd": "/", "timeoutMs": 60_000}, other)
                if status == 200:
                    took = round(time.time() - t0)
                    break
                codes.add((status, code_of(out)))
                time.sleep(5)
            seen = (out.get("stdout") or "").strip() if isinstance(out, dict) else out
            check(f"a running sandbox refuses another request until its idle stop ({idle} s), then takes it",
                  [sorted(codes), took, seen], [[(409, "resources_mismatch")], f"{idle}..{idle + 75}", str(m["vcpus"])],
                  codes == {(409, "resources_mismatch")} and took is not None and took >= idle and seen == str(m["vcpus"]))
            call("DELETE", f"{BASE}/{c}")
        else:
            print(f"  skip the idle-stop check: SANDBOXD_IDLE_SECS is {idle} (set it to 30 or less with LAB_SANDBOXD)")
    except Exception as e:
        check("the run itself", str(e)[:300], "no error", False)
    finally:
        for sid in (a, b):
            call("DELETE", f"{BASE}/{sid}")
    failed = [c["check"] for c in checks if not c["ok"]]
    print(json.dumps({"bench": "limits", "ok": not failed, "defaults": d, "asked": ask, "idle_secs": int(env.get("SANDBOXD_IDLE_SECS", "900")), "checks": len(checks), "failed": failed}))
    sys.exit(1 if failed else 0)


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
        "limits": limits,
        "clean": clean,
    }
    if cmd not in commands:
        sys.exit(__doc__)
    commands[cmd]()
