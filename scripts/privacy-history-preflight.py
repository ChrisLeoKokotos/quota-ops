#!/usr/bin/env python3
"""Read-only, count-only history preflight. Never print object contents or match values."""
import argparse
from collections import Counter
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

REMOTE = "https://github.com/ChrisLeoKokotos/quota-ops.git"
KNOWN_BLOBS = {
    b"87f3d6d2f56690fa92e26ef322cebc600d9bfc07",
    b"bf5fdf3b13699509a311ed932bd77ed9784de9f1",
}
PATTERNS = {
    "private_key_marker": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----"),
    "github_token_shape": re.compile(rb"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})"),
    "api_key_shape": re.compile(rb"(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}|AIza[0-9A-Za-z_-]{35}|AKIA[A-Z0-9]{16})"),
    "large_usage_candidate": re.compile(rb"\b(?:\d{1,3}(?:[,.]\d{3}){2,}|\d+(?:\.\d+)?\s*(?:billion|million))\s*(?:tokens|sessions|files)\b", re.I),
}

def git(*args):
    return subprocess.run(
        ["git", *map(str, args)], check=True, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, timeout=180,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    ).stdout

def refs(data):
    result = {}
    for line in data.splitlines():
        oid, name = line.split(maxsplit=1)
        if name in result or not name.startswith(b"refs/"):
            raise ValueError("unexpected ref")
        result[name] = oid
    return result

def read_bytes(stream, size, retain):
    chunks = []
    while size:
        chunk = stream.read(min(size, 1024 * 1024))
        if not chunk:
            raise RuntimeError("incomplete object")
        size -= len(chunk)
        if retain:
            chunks.append(chunk)
    return b"".join(chunks)

def scan(repo, known, limit=64 * 1024 * 1024):
    objects = set(git("-C", repo, "rev-list", "--objects", "--no-object-names", "--all").splitlines())
    counts, matches = Counter(), Counter()
    skipped = 0
    known_seen = set()
    proc = subprocess.Popen(
        ["git", "-C", str(repo), "cat-file", "--batch"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    try:
        for oid in sorted(objects):
            proc.stdin.write(oid + b"\n")
            proc.stdin.flush()
            header = proc.stdout.readline().split()
            if len(header) != 3 or header[0] != oid:
                raise RuntimeError("unexpected Git object")
            kind, size = header[1].decode("ascii"), int(header[2])
            counts[kind] += 1
            keep = size <= limit
            data = read_bytes(proc.stdout, size, keep)
            if proc.stdout.read(1) != b"\n":
                raise RuntimeError("invalid object terminator")
            if oid in known and kind == "blob":
                known_seen.add(oid)
            if not keep:
                skipped += 1
                continue
            if kind in {"blob", "commit", "tag"}:
                for name, pattern in PATTERNS.items():
                    matches[name] += bool(pattern.search(data))
        proc.stdin.close()
        if proc.wait() != 0:
            raise RuntimeError("object reader failed")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        proc.stdout.close()
        if not proc.stdin.closed:
            proc.stdin.close()
    local = refs(git("-C", repo, "for-each-ref", "--format=%(objectname) %(refname)"))
    reaching_known = 0
    if known_seen:
        for name in local:
            reachable = set(git("-C", repo, "rev-list", "--objects", "--no-object-names", os.fsdecode(name)).splitlines())
            reaching_known += bool(reachable & known_seen)
    return {
        "reachable_objects": len(objects),
        "object_types": dict(counts),
        "pattern_matching_objects": dict(matches),
        "known_affected_blobs_present": len(known_seen),
        "local_refs_reaching_known_blobs": reaching_known,
        "oversized_objects_skipped": skipped,
        "shallow": git("-C", repo, "rev-parse", "--is-shallow-repository").strip() == b"true",
    }

def preflight(remote, workspace, known, expected_head=None, expected_base=None):
    before = refs(git("ls-remote", "--refs", remote))
    if not before or b"refs/heads/main" not in before:
        raise RuntimeError("missing main ref")
    mirror = Path(workspace) / "mirror.git"
    git("clone", "--mirror", remote, mirror)
    git("-C", mirror, "fsck", "--full")
    local = refs(git("-C", mirror, "for-each-ref", "--format=%(objectname) %(refname)"))
    after = refs(git("ls-remote", "--refs", remote))
    report = {
        "advertised_refs_before": len(before),
        "advertised_refs_after": len(after),
        "local_refs": len(local),
        "heads": sum(name.startswith(b"refs/heads/") for name in local),
        "tags": sum(name.startswith(b"refs/tags/") for name in local),
        "pull_refs": sum(name.startswith(b"refs/pull/") for name in local),
        "remote_stable_during_clone": before == after,
        "mirror_matches_advertised_refs": before == after == local,
        "fsck_pass": True,
        "missing_refs": len(after.keys() - local.keys()),
        "extra_refs": len(local.keys() - after.keys()),
        "changed_targets": sum(local[name] != after[name] for name in local.keys() & after.keys()),
        "expected_head_matches": expected_head is None or local.get(b"refs/heads/integration/v0.2.0-safe-merge") == expected_head.encode("ascii"),
        "expected_base_matches": expected_base is None or local.get(b"refs/heads/main") == expected_base.encode("ascii"),
    }
    report.update(scan(mirror, known))
    report["complete_for_advertised_reachable_objects"] = (
        report["mirror_matches_advertised_refs"] and report["expected_head_matches"]
        and report["expected_base_matches"] and not report["shallow"]
        and report["oversized_objects_skipped"] == 0
    )
    report["scope"] = "Read-only advertised refs and bounded reachable objects; pattern candidates, not exact owner-approved terms or privacy clearance. Hidden server objects, LFS, caches and forks excluded."
    return report

def self_test():
    with tempfile.TemporaryDirectory(prefix="qo-history-fixture-") as root:
        src = Path(root) / "source"
        src.mkdir()
        git("-C", src, "init", "-b", "main")
        git("-C", src, "config", "user.name", "Synthetic fixture")
        git("-C", src, "config", "user.email", "fixture@example.invalid")
        # Assemble the synthetic token shape at runtime; do not commit a token-shaped fixture literal.
        fixture = ("gh" + "p_" + "Z" * 36).encode("ascii")
        (src / "example.txt").write_bytes(fixture)
        git("-C", src, "add", "example.txt")
        git("-C", src, "commit", "-m", "synthetic history")
        known = {git("-C", src, "rev-parse", "HEAD:example.txt").strip()}
        git("-C", src, "tag", "-a", "fixture-tag", "-m", "fixture annotation")
        git("-C", src, "update-ref", "refs/pull/1/head", "HEAD")
        (src / "example.txt").write_text("sanitized fixture\n", encoding="utf-8")
        git("-C", src, "add", "example.txt")
        git("-C", src, "commit", "-m", "sanitized")
        baseline = git("-C", src, "for-each-ref", "--format=%(objectname) %(refname)")
        report = preflight(str(src), root, known)
        if not (report["complete_for_advertised_reachable_objects"] and report["heads"] == 1
                and report["tags"] == 1 and report["pull_refs"] == 1
                and report["known_affected_blobs_present"] == 1
                and report["local_refs_reaching_known_blobs"] == 3
                and report["pattern_matching_objects"]["github_token_shape"] == 1
                and report["object_types"].get("tag") == 1
                and baseline == git("-C", src, "for-each-ref", "--format=%(objectname) %(refname)")):
            raise RuntimeError("fixture regression")
        bounded = scan(Path(root) / "mirror.git", known, limit=8)
        if not bounded["oversized_objects_skipped"]:
            raise RuntimeError("oversize bound regression")
    print("PASS: synthetic historical blob, annotated tag, PR ref, size bound and unchanged source refs.")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--expected-head")
    parser.add_argument("--expected-base")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
        raise RuntimeError("hosted runner required")
    if os.environ.get("GITHUB_REPOSITORY") != "ChrisLeoKokotos/quota-ops":
        raise RuntimeError("unexpected repository")
    if not all(value and re.fullmatch(r"[0-9a-f]{40}", value) for value in (args.expected_head, args.expected_base)):
        raise ValueError("expected candidate and base required")
    with tempfile.TemporaryDirectory(prefix="qo-history-preflight-") as root:
        report = preflight(REMOTE, root, KNOWN_BLOBS, args.expected_head, args.expected_base)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["complete_for_advertised_reachable_objects"] else 2

if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, KeyError):
        print("History preflight incomplete: Git/input/fixture operation failed; raw details suppressed.", file=sys.stderr)
        sys.exit(1)
