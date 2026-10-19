#!/usr/bin/env python3
"""Research fixture generator and independent Git object-graph capture.

No function in this file is a production Git/runtime implementation.  All
mutations are confined to a caller-selected empty directory or a fresh temp
directory, and all remotes are local bare repositories.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from typing import Any, Iterable, Mapping
from urllib.parse import quote


TOOL_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = TOOL_ROOT.parents[2]
DOC_ROOT = REPOSITORY_ROOT / "docs/research/git/qualification"
CATALOG_PATH = TOOL_ROOT / "scenario-catalog.json"
SOURCES_PATH = DOC_ROOT / "sources.lock.json"
MANIFEST_PATH = TOOL_ROOT / "MANIFEST.json"
SCHEMA_ROOT = TOOL_ROOT / "schemas"
FAULT_TRANSPORT = TOOL_ROOT / "fault_transport.py"
ORACLE_VERSION = "independent-git-filesystem-oracle/v1"
FIXTURE_VERSION = "bridlewise-git-fixture/v1"
SYNTHETIC_MARKER = "QUALIFICATION_SYNTHETIC_DO_NOT_USE"


class QualificationError(RuntimeError):
    pass


class GitCommandError(QualificationError):
    def __init__(self, command: list[str], returncode: int, stderr: str):
        super().__init__(f"Git command failed ({returncode}): {' '.join(command[:4])}: {stderr}")
        self.command = command
        self.returncode = returncode
        self.stderr = stderr


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n"
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(encoded, encoding="utf-8")
    os.replace(temporary, path)


def write_bytes(path: Path, data: bytes, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    if mode is not None:
        path.chmod(mode)


def write_text(path: Path, text: str, mode: int | None = None) -> None:
    write_bytes(path, text.encode("utf-8"), mode)


def sanitize_text(value: str, case_root: Path | None = None) -> str:
    value = re.sub(r"(?i)([a-z][a-z0-9+.-]*://)[^/@\s]+@", r"\1<redacted-userinfo>@", value)
    value = re.sub(r"(?i)\b(authorization|password|passwd|token|secret)=([^\s&]+)", r"\1=<redacted>", value)
    value = re.sub(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 <redacted>", value)
    if case_root is not None:
        value = value.replace(str(case_root.resolve()), "$CASE")
    return value


def isolated_environment(case_root: Path, repetition: int = 1) -> dict[str, str]:
    allowed = {"PATH", "SYSTEMROOT", "WINDIR", "TMPDIR", "TEMP", "TMP"}
    env = {key: value for key, value in os.environ.items() if key in allowed}
    home = case_root / "isolated-home"
    xdg = home / ".config"
    home.mkdir(parents=True, exist_ok=True)
    xdg.mkdir(parents=True, exist_ok=True)
    global_config = case_root / "control/empty-global.gitconfig"
    global_config.parent.mkdir(parents=True, exist_ok=True)
    global_config.touch(exist_ok=True)
    env.update({
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(xdg),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": str(global_config),
        "GIT_TERMINAL_PROMPT": "0",
        "GCM_INTERACTIVE": "Never",
        "GIT_OPTIONAL_LOCKS": "0",
        "LC_ALL": "C",
        "LANG": "C",
        "TZ": "UTC",
        "QUALIFICATION_CASE_ROOT": str(case_root.resolve()),
        "QUALIFICATION_REPETITION": str(repetition),
    })
    return env


def run_process(
    command: list[str],
    *,
    cwd: Path | None = None,
    env: Mapping[str, str] | None = None,
    input_bytes: bytes | None = None,
    check: bool = True,
    timeout: float = 30.0,
) -> subprocess.CompletedProcess[bytes]:
    completed = subprocess.run(
        command,
        cwd=cwd,
        env=dict(env) if env is not None else None,
        input=input_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=timeout,
    )
    if check and completed.returncode != 0:
        stderr = completed.stderr.decode("utf-8", "backslashreplace").strip()
        raise GitCommandError(command, completed.returncode, sanitize_text(stderr, cwd))
    return completed


def git(
    case_root: Path,
    cwd: Path | None,
    args: Iterable[str],
    *,
    repetition: int = 1,
    input_bytes: bytes | None = None,
    check: bool = True,
    timeout: float = 30.0,
    extra_env: Mapping[str, str] | None = None,
) -> subprocess.CompletedProcess[bytes]:
    executable = shutil.which("git")
    if executable is None:
        raise QualificationError("git executable unavailable")
    env = isolated_environment(case_root, repetition)
    if extra_env:
        env.update(extra_env)
    command = [
        executable,
        "-c", "protocol.file.allow=always",
        "-c", "advice.detachedHead=false",
        "-c", "commit.gpgsign=false",
        *args,
    ]
    return run_process(command, cwd=cwd, env=env, input_bytes=input_bytes, check=check, timeout=timeout)


def git_text(case_root: Path, cwd: Path | None, args: Iterable[str], **kwargs: Any) -> str:
    completed = git(case_root, cwd, args, **kwargs)
    return completed.stdout.decode("utf-8", "backslashreplace").strip()


def branch_for(repetition: int) -> str:
    return ("main", "trunk", "stable")[(repetition - 1) % 3]


def commit_environment(case_root: Path, repetition: int, ordinal: int) -> dict[str, str]:
    env = isolated_environment(case_root, repetition)
    timestamp = 978307200 + repetition * 86400 + ordinal * 97
    identity = f"Qualification Fixture {repetition}"
    env.update({
        "GIT_AUTHOR_NAME": identity,
        "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
        "GIT_COMMITTER_NAME": identity,
        "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
        "GIT_AUTHOR_DATE": f"@{timestamp} +0000",
        "GIT_COMMITTER_DATE": f"@{timestamp} +0000",
    })
    return env


def init_repository(case_root: Path, path: Path, branch: str, *, bare: bool = False, repetition: int = 1) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    args = ["init", "--quiet", f"--initial-branch={branch}"]
    if bare:
        args.append("--bare")
    args.append(str(path))
    git(case_root, None, args, repetition=repetition)
    if not bare:
        git(case_root, path, ["config", "user.name", "Qualification Fixture"], repetition=repetition)
        git(case_root, path, ["config", "user.email", "fixture@example.invalid"], repetition=repetition)
        git(case_root, path, ["config", "commit.gpgsign", "false"], repetition=repetition)


def commit_changes(
    case_root: Path,
    repository: Path,
    repetition: int,
    ordinal: int,
    message: str,
    changes: Mapping[str, str | bytes | None],
) -> str:
    for relative, value in changes.items():
        path = repository / relative
        if value is None:
            if path.is_symlink() or path.is_file():
                path.unlink()
            elif path.is_dir():
                shutil.rmtree(path)
            continue
        if isinstance(value, str):
            write_text(path, value)
        else:
            write_bytes(path, value)
    git(case_root, repository, ["add", "--all"], repetition=repetition)
    git(
        case_root,
        repository,
        ["commit", "--quiet", "-m", message],
        repetition=repetition,
        extra_env=commit_environment(case_root, repetition, ordinal),
    )
    return git_text(case_root, repository, ["rev-parse", "HEAD"], repetition=repetition)


def create_bare_remote(
    case_root: Path,
    name: str,
    repetition: int,
    *,
    commits: int = 2,
    branch: str | None = None,
    with_tag: bool = False,
) -> tuple[Path, Path]:
    branch = branch or branch_for(repetition)
    remote = case_root / "remotes" / f"{name}.git"
    seed = case_root / "peers" / f"seed-{name}"
    init_repository(case_root, remote, branch, bare=True, repetition=repetition)
    init_repository(case_root, seed, branch, repetition=repetition)
    for ordinal in range(1, commits + 1):
        commit_changes(
            case_root,
            seed,
            repetition,
            ordinal,
            f"fixture-{name}-{ordinal}",
            {f"history/{ordinal:02d}.txt": f"{name}:{repetition}:{ordinal}\n"},
        )
    if with_tag:
        git(case_root, seed, ["tag", f"qualification-v{repetition}"], repetition=repetition)
    git(case_root, seed, ["remote", "add", "destination", str(remote)], repetition=repetition)
    refspecs = [f"refs/heads/{branch}:refs/heads/{branch}"]
    if with_tag:
        refspecs.append(f"refs/tags/qualification-v{repetition}:refs/tags/qualification-v{repetition}")
    git(case_root, seed, ["push", "--quiet", "destination", *refspecs], repetition=repetition)
    git(case_root, remote, ["symbolic-ref", "HEAD", f"refs/heads/{branch}"], repetition=repetition)
    return remote, seed


def clone_local(case_root: Path, remote: Path, destination: Path, repetition: int, *options: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    git(case_root, None, ["clone", "--quiet", *options, remote.as_uri(), str(destination)], repetition=repetition)
    git(case_root, destination, ["config", "user.name", "Qualification Fixture"], repetition=repetition)
    git(case_root, destination, ["config", "user.email", "fixture@example.invalid"], repetition=repetition)
    git(case_root, destination, ["config", "commit.gpgsign", "false"], repetition=repetition)


def relative_to_case(path: Path, case_root: Path) -> str:
    try:
        return path.resolve().relative_to(case_root.resolve()).as_posix()
    except (FileNotFoundError, ValueError):
        return sanitize_text(str(path), case_root)


def decode_nul(output: bytes) -> list[str]:
    return [item.decode("utf-8", "backslashreplace") for item in output.split(b"\0") if item]


def safe_git_capture(case_root: Path, repository: Path, args: list[str], *, nul: bool = False) -> dict[str, Any]:
    completed = git(case_root, repository, args, check=False)
    stdout = decode_nul(completed.stdout) if nul else sanitize_text(
        completed.stdout.decode("utf-8", "backslashreplace").strip(), case_root
    )
    stderr = sanitize_text(completed.stderr.decode("utf-8", "backslashreplace").strip(), case_root)
    return {"returncode": completed.returncode, "stdout": stdout, "stderr": stderr}


def inspect_repository(case_root: Path, repository: Path) -> dict[str, Any]:
    result: dict[str, Any] = {
        "path": relative_to_case(repository, case_root),
        "exists": repository.exists(),
        "kind": "absent",
    }
    if not repository.exists():
        return result

    bare_probe = safe_git_capture(case_root, repository, ["rev-parse", "--is-bare-repository"])
    inside_probe = safe_git_capture(case_root, repository, ["rev-parse", "--is-inside-work-tree"])
    git_dir_probe = safe_git_capture(case_root, repository, ["rev-parse", "--absolute-git-dir"])
    common_probe = safe_git_capture(case_root, repository, ["rev-parse", "--git-common-dir"])
    if git_dir_probe["returncode"] != 0:
        result.update({
            "kind": "non-repository-or-corrupt",
            "probes": {"bare": bare_probe, "insideWorktree": inside_probe, "gitDir": git_dir_probe},
        })
        return result

    is_bare = bare_probe["stdout"] == "true"
    result["kind"] = "bare" if is_bare else "worktree"
    result["repositoryFacts"] = {
        "isBare": is_bare,
        "insideWorktree": inside_probe["stdout"] == "true",
        "gitDir": sanitize_text(str(git_dir_probe["stdout"]), case_root),
        "commonDir": sanitize_text(str(common_probe["stdout"]), case_root),
        "objectFormat": safe_git_capture(case_root, repository, ["rev-parse", "--show-object-format"]),
    }
    symbolic = safe_git_capture(case_root, repository, ["symbolic-ref", "--quiet", "HEAD"])
    head = safe_git_capture(case_root, repository, ["rev-parse", "--verify", "HEAD"])
    if head["returncode"] != 0 and symbolic["returncode"] == 0:
        head_state = "unborn"
    elif head["returncode"] == 0 and symbolic["returncode"] != 0:
        head_state = "detached"
    elif head["returncode"] == 0:
        head_state = "attached"
    else:
        head_state = "invalid-or-missing"
    result["head"] = {"state": head_state, "symbolic": symbolic, "oid": head}

    refs_capture = safe_git_capture(
        case_root,
        repository,
        ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(upstream:short)"],
        nul=True,
    )
    refs_raw = refs_capture["stdout"] if isinstance(refs_capture["stdout"], list) else []
    refs: list[dict[str, str]] = []
    for offset in range(0, len(refs_raw), 4):
        fields = refs_raw[offset:offset + 4]
        if len(fields) == 4:
            refs.append({"ref": fields[0], "oid": fields[1], "type": fields[2], "upstream": fields[3]})
    result["refs"] = refs

    objects_process = git(case_root, repository, ["rev-list", "--objects", "--all"], check=False)
    object_rows: list[dict[str, Any]] = []
    if objects_process.returncode == 0:
        oid_paths: list[tuple[str, str]] = []
        for line in objects_process.stdout.decode("utf-8", "backslashreplace").splitlines():
            oid, _, path = line.partition(" ")
            if re.fullmatch(r"[a-f0-9]{40,64}", oid):
                oid_paths.append((oid, path))
        if oid_paths:
            batch_input = "".join(f"{oid}\n" for oid, _ in oid_paths).encode("ascii")
            batch = git(
                case_root,
                repository,
                ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
                input_bytes=batch_input,
                check=False,
            )
            metadata: dict[str, tuple[str, int]] = {}
            for line in batch.stdout.decode("ascii", "replace").splitlines():
                fields = line.split()
                if len(fields) == 3 and fields[2].isdigit():
                    metadata[fields[0]] = (fields[1], int(fields[2]))
            for oid, path in sorted(oid_paths):
                object_type, size = metadata.get(oid, ("missing", -1))
                row: dict[str, Any] = {"oid": oid, "type": object_type, "size": size, "path": path}
                if object_type == "blob" and 0 <= size <= 1024 * 1024:
                    blob = git(case_root, repository, ["cat-file", "blob", oid], check=False)
                    if blob.returncode == 0:
                        row["contentSha256"] = hashlib.sha256(blob.stdout).hexdigest()
                object_rows.append(row)
    result["objects"] = object_rows

    commit_edges: list[dict[str, Any]] = []
    for row in object_rows:
        if row["type"] != "commit":
            continue
        commit = git(case_root, repository, ["cat-file", "commit", row["oid"]], check=False)
        headers = commit.stdout.split(b"\n\n", 1)[0].decode("ascii", "replace").splitlines()
        commit_edges.append({
            "oid": row["oid"],
            "tree": next((line[5:] for line in headers if line.startswith("tree ")), ""),
            "parents": [line[7:] for line in headers if line.startswith("parent ")],
        })
    result["commitEdges"] = sorted(commit_edges, key=lambda item: item["oid"])

    result["index"] = safe_git_capture(case_root, repository, ["ls-files", "--stage", "-z"], nul=True)
    result["status"] = safe_git_capture(
        case_root,
        repository,
        ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
        nul=True,
    )
    result["ignored"] = safe_git_capture(
        case_root,
        repository,
        ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
        nul=True,
    )
    result["worktrees"] = safe_git_capture(case_root, repository, ["worktree", "list", "--porcelain"])
    result["fsck"] = safe_git_capture(case_root, repository, ["fsck", "--strict", "--no-progress"])

    remote_rows: list[dict[str, Any]] = []
    remotes = safe_git_capture(case_root, repository, ["remote"])
    if remotes["returncode"] == 0 and isinstance(remotes["stdout"], str):
        for name in sorted(filter(None, remotes["stdout"].splitlines())):
            fetch_urls = safe_git_capture(case_root, repository, ["remote", "get-url", "--all", name])
            push_urls = safe_git_capture(case_root, repository, ["remote", "get-url", "--push", "--all", name])
            fetch_specs = safe_git_capture(case_root, repository, ["config", "--get-all", f"remote.{name}.fetch"])
            push_specs = safe_git_capture(case_root, repository, ["config", "--get-all", f"remote.{name}.push"])
            remote_rows.append({
                "name": name,
                "fetchUrls": fetch_urls,
                "pushUrls": push_urls,
                "fetchRefspecs": fetch_specs,
                "pushRefspecs": push_specs,
            })
    result["remotes"] = remote_rows

    result["shallow"] = safe_git_capture(case_root, repository, ["rev-parse", "--is-shallow-repository"])
    result["partial"] = {
        "promisor": safe_git_capture(case_root, repository, ["config", "--get-regexp", r"^remote\..*\.promisor$"]),
        "filter": safe_git_capture(case_root, repository, ["config", "--get-regexp", r"^remote\..*\.partialclonefilter$"]),
    }
    result["operationMarkers"] = inspect_operation_markers(case_root, git_dir_probe["stdout"])
    return result


def inspect_operation_markers(case_root: Path, git_dir_text: Any) -> list[dict[str, Any]]:
    if not isinstance(git_dir_text, str):
        return []
    git_dir = Path(git_dir_text)
    if not git_dir.is_absolute():
        return []
    names = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge"]
    rows: list[dict[str, Any]] = []
    for name in names:
        path = git_dir / name
        if path.exists() or path.is_symlink():
            rows.append({"path": sanitize_text(str(path), case_root), "kind": "operation"})
    try:
        for path in git_dir.rglob("*.lock"):
            rows.append({"path": sanitize_text(str(path), case_root), "kind": "lock"})
    except OSError:
        pass
    return sorted(rows, key=lambda item: item["path"])


def filesystem_snapshot(case_root: Path) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    excluded_prefixes = {"control/oracle.json", "control/self-test.json"}
    for path in sorted(case_root.rglob("*"), key=lambda item: item.as_posix()):
        relative = path.relative_to(case_root).as_posix()
        if relative in excluded_prefixes or relative.startswith("isolated-home/"):
            continue
        try:
            info = path.lstat()
        except OSError as error:
            rows.append({"path": relative, "kind": "error", "error": error.__class__.__name__})
            continue
        mode = stat.S_IMODE(info.st_mode)
        if stat.S_ISLNK(info.st_mode):
            target = sanitize_text(os.readlink(path), case_root)
            rows.append({"path": relative, "kind": "symlink", "mode": mode, "target": target})
        elif stat.S_ISDIR(info.st_mode):
            rows.append({"path": relative, "kind": "directory", "mode": mode})
        elif stat.S_ISREG(info.st_mode):
            rows.append({"path": relative, "kind": "file", "mode": mode, "size": info.st_size, "sha256": file_hash(path)})
        else:
            rows.append({"path": relative, "kind": "special", "mode": mode})
    return {"entries": rows, "sha256": canonical_hash(rows)}


def inspect_fixture(case_root: Path) -> dict[str, Any]:
    manifest_path = case_root / "control/fixture.json"
    if not manifest_path.is_file():
        raise QualificationError(f"fixture manifest missing: {manifest_path}")
    fixture = load_json(manifest_path)
    repositories: dict[str, Any] = {}
    for role, relative in sorted(fixture.get("repositories", {}).items()):
        repositories[role] = inspect_repository(case_root, case_root / relative)
    graph_value = {
        "oracleVersion": ORACLE_VERSION,
        "scenarioId": fixture["scenarioId"],
        "repetition": fixture["repetition"],
        "variant": fixture["variant"],
        "repositories": repositories,
    }
    filesystem = filesystem_snapshot(case_root)
    return {
        **graph_value,
        "graphSha256": canonical_hash(graph_value),
        "filesystemSha256": filesystem["sha256"],
        "filesystem": filesystem,
    }


class FixtureBuilder:
    def __init__(self, root: Path, scenario: Mapping[str, Any], repetition: int):
        self.root = root
        self.scenario = scenario
        self.repetition = repetition
        variants = scenario["repetitions"]["variants"]
        self.variant = variants[(repetition - 1) % len(variants)]
        self.branch = branch_for(repetition)
        self.repositories: dict[str, str] = {}
        self.blockers: list[str] = []
        self.notes: list[str] = []
        for name in ("control", "workspace", "peers", "remotes", "install", "isolated-home"):
            (root / name).mkdir(parents=True, exist_ok=True)

    def record(self, role: str, path: Path) -> None:
        self.repositories[role] = path.relative_to(self.root).as_posix()

    def repository(self, role: str = "workspace", commits: int = 1) -> Path:
        path = self.root / ("workspace" if role == "workspace" else f"peers/{role}")
        if path.exists() and any(path.iterdir()):
            shutil.rmtree(path)
        init_repository(self.root, path, self.branch, repetition=self.repetition)
        for ordinal in range(1, commits + 1):
            commit_changes(
                self.root, path, self.repetition, ordinal,
                f"{role}-{ordinal}",
                {f"src/{role}-{ordinal}.txt": f"{self.scenario['id']}:{self.variant}:{ordinal}\n"},
            )
        self.record(role, path)
        return path

    def remote_and_clone(self, name: str = "upstream", commits: int = 2) -> tuple[Path, Path]:
        remote, seed = create_bare_remote(
            self.root, name, self.repetition, commits=commits, branch=self.branch,
            with_tag="tag" in self.variant,
        )
        workspace = self.root / "workspace"
        if workspace.exists() and any(workspace.iterdir()):
            shutil.rmtree(workspace)
        clone_local(self.root, remote, workspace, self.repetition)
        self.record("workspace", workspace)
        self.record(name, remote)
        self.record(f"seed-{name}", seed)
        return remote, workspace

    def build(self) -> dict[str, Any]:
        generator = self.scenario["fixture"]["generator"]
        profile = self.scenario["fixture"]["profile"]
        dispatch = {
            "workspace": self.build_workspace,
            "repository-state": self.build_repository_state,
            "remote-graph": self.build_remote_graph,
            "never-push": self.build_never_push,
            "fault": self.build_fault,
            "self-evolution": self.build_self_evolution,
            "hosted-spec": self.build_hosted_spec,
        }
        dispatch[generator](profile)
        fixture = {
            "schemaVersion": FIXTURE_VERSION,
            "scenarioId": self.scenario["id"],
            "repetition": self.repetition,
            "variant": self.variant,
            "generator": generator,
            "profile": profile,
            "repositories": dict(sorted(self.repositories.items())),
            "networkMutation": False,
            "blockers": sorted(self.blockers),
            "notes": sorted(self.notes),
            "idempotencyKey": canonical_hash({
                "scenario": self.scenario["id"], "repetition": self.repetition,
                "variant": self.variant,
            }),
        }
        write_json(self.root / "control/fixture.json", fixture)
        return fixture

    def build_workspace(self, profile: str) -> None:
        workspace = self.root / "workspace"
        if profile in {"empty-init", "classification-no-repo"}:
            if "populated" in self.variant:
                write_text(workspace / "existing.txt", f"{self.variant}\n")
            return
        if profile == "empty-clone":
            commits = 1 if "one" in self.variant else 3 if "three" in self.variant else 5
            remote, _ = create_bare_remote(
                self.root, "source", self.repetition, commits=commits,
                branch=self.branch, with_tag="tag" in self.variant,
            )
            self.record("source", remote)
            return
        if profile in {"nonempty-import", "nonempty-clone-separate"}:
            write_text(workspace / "notes/readme.txt", f"baseline:{self.variant}\n")
            write_text(workspace / "package-lock.json", '{"lockfileVersion":3}\n')
            if "binary" in self.variant:
                write_bytes(workspace / "assets/sample.bin", bytes(range(32)))
            if "unicode" in self.variant:
                write_text(workspace / "café.txt", "synthetic\n")
            if profile == "nonempty-clone-separate":
                remote, _ = create_bare_remote(self.root, "source", self.repetition, commits=2, branch=self.branch)
                self.record("source", remote)
                if "same-path-different" in self.variant:
                    write_text(workspace / "history/01.txt", "local collision\n")
            return
        if profile == "existing-attach":
            repo = self.repository()
            remote, _ = create_bare_remote(self.root, "source", self.repetition, commits=2, branch=self.branch)
            self.record("source", remote)
            if "matching" in self.variant:
                git(self.root, repo, ["remote", "add", "source", str(remote)], repetition=self.repetition)
            elif "conflicting" in self.variant:
                other, _ = create_bare_remote(self.root, "other", self.repetition, commits=1, branch=self.branch)
                self.record("other", other)
                git(self.root, repo, ["remote", "add", "source", str(other)], repetition=self.repetition)
            return
        raise QualificationError(f"unknown workspace profile: {profile}")

    def build_repository_state(self, profile: str) -> None:
        if profile == "repository-kinds":
            if "ordinary" in self.variant:
                self.repository()
            elif "bare" in self.variant:
                remote, _ = create_bare_remote(self.root, "bare", self.repetition, branch=self.branch)
                self.record("workspace", remote)
            else:
                main = self.repository("main-worktree")
                workspace = self.root / "workspace"
                git(self.root, main, ["branch", "linked"], repetition=self.repetition)
                git(self.root, main, ["worktree", "add", "--quiet", str(workspace), "linked"], repetition=self.repetition)
                self.record("workspace", workspace)
            return
        if profile == "nested":
            workspace = self.root / "workspace"
            if "inside-parent" in self.variant or "parent-and-child" in self.variant:
                parent = self.root / "peers/parent"
                init_repository(self.root, parent, self.branch, repetition=self.repetition)
                commit_changes(self.root, parent, self.repetition, 1, "parent", {"workspace/base.txt": "parent\n"})
                if workspace.exists():
                    shutil.rmtree(workspace)
                workspace.symlink_to(parent / "workspace", target_is_directory=True)
                self.record("parent", parent)
            if "contains-child" in self.variant or "parent-and-child" in self.variant:
                if workspace.is_symlink():
                    workspace = workspace.resolve()
                child = workspace / "child"
                init_repository(self.root, child, self.branch, repetition=self.repetition)
                commit_changes(self.root, child, self.repetition, 2, "child", {"child.txt": "child\n"})
                self.record("child", child)
            return
        if profile == "head-and-dirty":
            if "unborn" in self.variant:
                repo = self.root / "workspace"
                init_repository(self.root, repo, self.branch, repetition=self.repetition)
                write_text(repo / "untracked.txt", "untracked\n")
                self.record("workspace", repo)
            else:
                repo = self.repository()
                if "detached" in self.variant:
                    git(self.root, repo, ["switch", "--detach", "--quiet", "HEAD"], repetition=self.repetition)
                else:
                    tracked = repo / "src/workspace-1.txt"
                    tracked.write_text("unstaged\n", encoding="utf-8")
                    write_text(repo / "staged.txt", "staged\n")
                    git(self.root, repo, ["add", "staged.txt"], repetition=self.repetition)
                    write_text(repo / ".gitignore", "ignored.tmp\n")
                    write_text(repo / "ignored.tmp", "ignored\n")
                    write_text(repo / "untracked.txt", "untracked\n")
            return
        if profile == "corrupt":
            repo = self.repository()
            git_dir = repo / ".git"
            if "invalid-head" in self.variant:
                write_text(git_dir / "HEAD", "not-a-valid-head\n")
            elif "missing-reachable" in self.variant:
                oid = git_text(self.root, repo, ["rev-parse", "HEAD:src/workspace-1.txt"])
                object_path = git_dir / "objects" / oid[:2] / oid[2:]
                object_path.unlink()
            else:
                git(self.root, repo, ["pack-refs", "--all"], repetition=self.repetition)
                write_text(git_dir / "packed-refs", "malformed packed refs\n")
            return
        if profile == "locked":
            repo = self.repository()
            if "index" in self.variant:
                write_text(repo / ".git/index.lock", "synthetic lock\n")
            elif "branch-ref" in self.variant:
                write_text(repo / f".git/refs/heads/{self.branch}.lock", "synthetic lock\n")
            else:
                write_text(repo / ".git/MERGE_HEAD", git_text(self.root, repo, ["rev-parse", "HEAD"]) + "\n")
                (repo / ".git/rebase-merge").mkdir()
            return
        if profile == "shallow":
            remote, _ = create_bare_remote(self.root, "source", self.repetition, commits=6, branch=self.branch)
            depth = "1" if "depth-one" in self.variant else "2"
            clone_local(self.root, remote, self.root / "workspace", self.repetition, f"--depth={depth}", "--single-branch")
            self.record("source", remote)
            self.record("workspace", self.root / "workspace")
            return
        if profile == "partial":
            remote, _ = create_bare_remote(self.root, "source", self.repetition, commits=3, branch=self.branch)
            git(self.root, remote, ["config", "uploadpack.allowFilter", "true"], repetition=self.repetition)
            filter_spec = "blob:none" if "blob-none" in self.variant else "blob:limit=8"
            try:
                clone_local(
                    self.root, remote, self.root / "workspace", self.repetition,
                    "--no-checkout", f"--filter={filter_spec}",
                )
                self.record("workspace", self.root / "workspace")
            except (GitCommandError, subprocess.TimeoutExpired) as error:
                self.blockers.append(f"partial clone probe unavailable: {error.__class__.__name__}")
            self.record("source", remote)
            return
        if profile == "submodule":
            subremote, _ = create_bare_remote(self.root, "submodule", self.repetition, commits=2, branch=self.branch)
            repo = self.repository()
            git(self.root, repo, ["submodule", "add", "--quiet", subremote.as_uri(), "vendor/sub"], repetition=self.repetition)
            commit_changes(self.root, repo, self.repetition, 3, "add-submodule", {})
            if "dirty" in self.variant:
                write_text(repo / "vendor/sub/dirty.txt", "dirty\n")
            if "missing-worktree" in self.variant:
                shutil.rmtree(repo / "vendor/sub")
            self.record("submodule-remote", subremote)
            return
        if profile == "lfs":
            repo = self.repository()
            content = f"lfs:{self.repetition}:{self.variant}\n".encode()
            oid = hashlib.sha256(content).hexdigest()
            size = len(content) + (1 if "mismatched" in self.variant else 0)
            pointer = f"version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize {size}\n"
            if "malformed" in self.variant:
                pointer = f"version invalid\noid sha256:{oid}\nsize {size}\n"
            commit_changes(
                self.root, repo, self.repetition, 3, "lfs-pointer",
                {".gitattributes": "asset.bin filter=lfs diff=lfs merge=lfs -text\n", "asset.bin": pointer},
            )
            if "present-local" in self.variant:
                write_bytes(repo / f".git/lfs/objects/{oid[:2]}/{oid[2:4]}/{oid}", content)
            if shutil.which("git-lfs") is None:
                self.blockers.append("git-lfs unavailable; pointer fixture generated but LFS fsck gated")
            return
        if profile == "signing":
            repo = self.repository()
            git(self.root, repo, ["config", "commit.gpgsign", "true"], repetition=self.repetition)
            git(self.root, repo, ["config", "user.signingkey", "qualification-missing-signer"], repetition=self.repetition)
            if shutil.which("gpg") is None:
                self.blockers.append("approved test signer/GPG unavailable")
            return
        raise QualificationError(f"unknown repository-state profile: {profile}")

    def build_remote_graph(self, profile: str) -> None:
        if profile == "upstream-fork":
            upstream, workspace = self.remote_and_clone("upstream", commits=3)
            fork = self.root / "remotes/fork.git"
            init_repository(self.root, fork, self.branch, bare=True, repetition=self.repetition)
            git(self.root, workspace, ["remote", "rename", "origin", "upstream"], repetition=self.repetition)
            git(self.root, workspace, ["remote", "add", "origin", str(fork)], repetition=self.repetition)
            git(self.root, workspace, ["config", "remote.origin.push", f"refs/heads/{self.branch}:refs/heads/{self.branch}"], repetition=self.repetition)
            self.record("fork", fork)
            self.notes.append(f"fetch={relative_to_case(upstream, self.root)} push={relative_to_case(fork, self.root)}")
            return
        if profile in {"ahead-behind", "diverged"}:
            remote, workspace = self.remote_and_clone("upstream", commits=2)
            if profile == "ahead-behind" and "equal" in self.variant:
                return
            if profile == "ahead-behind" and "local-ahead" in self.variant:
                commit_changes(self.root, workspace, self.repetition, 10, "local-ahead", {"local.txt": "ahead\n"})
                return
            if profile == "diverged":
                commit_changes(self.root, workspace, self.repetition, 10, "local-diverged", {"local.txt": "local\n"})
            peer = self.root / "peers/concurrent"
            clone_local(self.root, remote, peer, self.repetition)
            count = 3 if "three" in self.variant or "ahead-three" in self.variant else 1
            for index in range(count):
                commit_changes(self.root, peer, self.repetition, 20 + index, f"peer-{index}", {f"peer-{index}.txt": "peer\n"})
            git(self.root, peer, ["push", "--quiet", "origin", f"HEAD:refs/heads/{self.branch}"], repetition=self.repetition)
            self.record("peer", peer)
            return
        if profile == "unrelated":
            repo = self.repository()
            remote, _ = create_bare_remote(self.root, "upstream", self.repetition, commits=2, branch=self.branch)
            git(self.root, repo, ["remote", "add", "upstream", str(remote)], repetition=self.repetition)
            if "same-path" in self.variant:
                commit_changes(self.root, repo, self.repetition, 8, "collision", {"history/01.txt": "unrelated local\n"})
            self.record("upstream", remote)
            return
        if profile in {"protected-refs", "atomic"}:
            remote, workspace = self.remote_and_clone("destination", commits=2)
            commit_changes(self.root, workspace, self.repetition, 9, "proposed", {"proposal.txt": "proposal\n"})
            if "pre-receive" in self.variant or "hook-rejection" in self.variant:
                hook = remote / "hooks/pre-receive"
                write_text(hook, "#!/bin/sh\nexit 1\n", 0o755)
            if "non-fast" in self.variant:
                git(self.root, remote, ["config", "receive.denyNonFastForwards", "true"], repetition=self.repetition)
            if "deny-delete" in self.variant:
                git(self.root, remote, ["config", "receive.denyDeletes", "true"], repetition=self.repetition)
            if "atomic-unsupported" in self.variant:
                self.write_fault_spec("atomic-unsupported", "before-service", "receive-pack", remote)
            return
        raise QualificationError(f"unknown remote-graph profile: {profile}")

    def build_never_push(self, profile: str) -> None:
        repo = self.repository()
        if profile == "managed-ignore":
            if "user-rules" in self.variant:
                write_text(repo / ".gitignore", "# user before\n*.user\n# user after\n")
            elif "existing-managed" in self.variant:
                write_text(repo / ".gitignore", "# user\n# BEGIN CODE-HARNESS MANAGED\nold.tmp\n# END CODE-HARNESS MANAGED\n")
            return
        if profile == "tracked-ignore-negation":
            path = "protected.synthetic"
            if "already-tracked" in self.variant:
                commit_changes(self.root, repo, self.repetition, 3, "tracked-protected", {path: SYNTHETIC_MARKER + "\n"})
                write_text(repo / ".gitignore", f"{path}\n")
            elif "negated" in self.variant:
                write_text(repo / ".gitignore", "*.synthetic\n!protected.synthetic\n")
                write_text(repo / path, SYNTHETIC_MARKER + "\n")
            else:
                write_text(repo / ".gitignore", f"{path}\n")
                write_text(repo / path, SYNTHETIC_MARKER + "\n")
            return
        if profile == "historical":
            original = "protected.synthetic"
            commit_changes(self.root, repo, self.repetition, 3, "add-protected", {original: SYNTHETIC_MARKER + "\n"})
            if "renamed" in self.variant:
                commit_changes(self.root, repo, self.repetition, 4, "rename-protected", {original: None, "renamed.txt": SYNTHETIC_MARKER + "\n"})
                commit_changes(self.root, repo, self.repetition, 5, "remove-protected", {"renamed.txt": None})
            else:
                commit_changes(self.root, repo, self.repetition, 4, "remove-protected", {original: None})
            return
        if profile == "root-classes":
            path = "private/synthetic.txt"
            marker = {
                "synthetic-credential-and-key-marker": "SYNTHETIC PRIVATE KEY MARKER",
                "synthetic-raw-conversation-marker": "SYNTHETIC RAW CONVERSATION MARKER",
                "synthetic-harness-private-state-marker": "SYNTHETIC HARNESS PRIVATE STATE MARKER",
            }[self.variant]
            commit_changes(self.root, repo, self.repetition, 3, "root-class", {path: f"{SYNTHETIC_MARKER}:{marker}\n"})
            return
        if profile == "generated-classes":
            if "cache" in self.variant:
                changes = {"node_modules/pkg/cache.bin": b"cache", ".cache/state": "cache\n"}
            elif "database" in self.variant:
                changes = {"runtime/transient.sqlite": b"SQLite format 3\x00synthetic"}
            else:
                changes = {"generated/large.bin": b"x" * 4096}
            commit_changes(self.root, repo, self.repetition, 3, "generated-class", changes)
            return
        if profile == "aliases":
            target = self.root / "control/outside.synthetic"
            write_text(target, SYNTHETIC_MARKER + "\n")
            if "symlink" in self.variant and hasattr(os, "symlink"):
                os.symlink(target, repo / "alias.txt")
                git(self.root, repo, ["add", "alias.txt"], repetition=self.repetition)
            elif "case-fold" in self.variant:
                write_text(repo / "Protected.txt", SYNTHETIC_MARKER + "\n")
                write_text(repo / "protected.txt", "case alias\n")
                git(self.root, repo, ["add", "Protected.txt", "protected.txt"], repetition=self.repetition)
            else:
                commit_changes(self.root, repo, self.repetition, 3, "rename-source", {"protected.synthetic": SYNTHETIC_MARKER + "\n"})
                commit_changes(self.root, repo, self.repetition, 4, "renamed", {"protected.synthetic": None, "benign.txt": SYNTHETIC_MARKER + "\n"})
            return
        if profile == "submodule-lfs":
            if "submodule-url" in self.variant:
                commit_changes(self.root, repo, self.repetition, 3, "gitmodules", {".gitmodules": f"[submodule \"synthetic\"]\n\tpath = vendor/synthetic\n\turl = https://{SYNTHETIC_MARKER}@example.invalid/repo\n"})
            elif "gitlink" in self.variant:
                subremote, _ = create_bare_remote(self.root, "submodule", self.repetition, commits=1, branch=self.branch)
                git(self.root, repo, ["submodule", "add", "--quiet", subremote.as_uri(), "vendor/sub"], repetition=self.repetition)
                commit_changes(self.root, repo, self.repetition, 3, "submodule", {})
                self.record("submodule-remote", subremote)
            else:
                oid = hashlib.sha256(SYNTHETIC_MARKER.encode()).hexdigest()
                commit_changes(self.root, repo, self.repetition, 3, "lfs", {"asset.bin": f"version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize 999\n"})
                self.blockers.append("git-lfs/destination object verification required")
            return
        if profile == "preservation-controls":
            path = "package-lock.json" if "lockfile" in self.variant else "artifact-manifest.json" if "manifest" in self.variant else "reproducibility-receipt.json"
            commit_changes(self.root, repo, self.repetition, 3, "preservation", {path: '{"synthetic":true,"secretFree":true}\n'})
            return
        if profile == "remote-url-auth":
            if "https" in self.variant:
                url = f"https://{SYNTHETIC_MARKER}@example.invalid/repository"
                git(self.root, repo, ["remote", "add", "unsafe", url], repetition=self.repetition)
            elif "scp-like" in self.variant:
                git(self.root, repo, ["remote", "add", "identity-only", "qualification-user@example.invalid:repository"], repetition=self.repetition)
            else:
                git(self.root, repo, ["config", "credential.helper", "store"], repetition=self.repetition)
            return
        raise QualificationError(f"unknown never-push profile: {profile}")

    def write_fault_spec(self, fault_class: str, boundary: str, service: str, remote: Path | None = None) -> None:
        spec = {
            "schemaVersion": "bridlewise-git-fault/v1",
            "class": fault_class,
            "boundary": boundary,
            "service": service,
            "remote": relative_to_case(remote, self.root) if remote else None,
            "transportProgram": relative_to_case(FAULT_TRANSPORT, REPOSITORY_ROOT),
            "containsSecret": False,
        }
        write_json(self.root / "control/fault.json", spec)

    def build_fault(self, profile: str) -> None:
        if profile == "auth-negotiation":
            mapping = {"provider-absent": "auth-absent", "opaque-capability-expired": "auth-expired", "opaque-capability-wrong-host-or-scope": "auth-wrong-scope"}
            self.write_fault_spec(mapping[self.variant], "before-service", "upload-pack")
            return
        remote, workspace = self.remote_and_clone("destination", commits=2)
        if profile == "idempotent-success":
            self.write_fault_spec("repeat-success", self.variant, "receive-pack", remote)
        elif profile == "leases":
            write_json(self.root / "control/lease.json", {"owner": "synthetic-owner", "scope": self.variant, "expires": "2001-01-04T00:00:00Z"})
        elif profile == "concurrent-push":
            peer = self.root / "peers/concurrent-writer"
            clone_local(self.root, remote, peer, self.repetition)
            commit_changes(self.root, peer, self.repetition, 20, "peer-move", {"peer.txt": self.variant + "\n"})
            git(self.root, peer, ["push", "--quiet", "origin", f"HEAD:refs/heads/{self.branch}"], repetition=self.repetition)
            self.record("peer", peer)
        elif profile == "ambiguous-transport":
            commit_changes(self.root, workspace, self.repetition, 10, "proposed", {"proposal.txt": "proposal\n"})
            mode = "service-then-fail" if "then-fail" in self.variant else "delay-before"
            service = "receive-pack" if "receive" in self.variant else "upload-pack"
            self.write_fault_spec(mode, self.variant, service, remote)
        elif profile in {"crash-boundaries", "rollback-boundaries"}:
            self.write_fault_spec("candidate-process-kill" if profile.startswith("crash") else "candidate-effect-failure", self.variant, "receive-pack", remote)
            self.blockers.append("candidate boundary event channel and external kill/compensation controller required")
        elif profile == "partial-dependencies":
            self.write_fault_spec("partial-dependency-effect", self.variant, "receive-pack", remote)
            if "hook" in self.variant:
                write_text(remote / "hooks/pre-receive", "#!/bin/sh\nexit 1\n", 0o755)
            self.blockers.append("submodule/LFS candidate dependency adapter required")
        elif profile == "network-failures":
            mode = "fail-before" if "offline" in self.variant else "delay-before" if "slow" in self.variant else "reset-before"
            self.write_fault_spec(mode, self.variant, "upload-pack", remote)
        else:
            raise QualificationError(f"unknown fault profile: {profile}")

    def build_self_evolution(self, profile: str) -> None:
        versions = self.root / "install/versions"
        staging = self.root / "peers/update-staging"
        init_repository(self.root, staging, self.branch, repetition=self.repetition)
        commit_changes(self.root, staging, self.repetition, 1, "module-bundle", {"module/provider.txt": f"provider:{self.variant}\n", "dependency.lock": "locked\n"})
        self.record("staging", staging)
        for version in ("v1", "v2"):
            directory = versions / version
            write_text(directory / "module.txt", f"installed:{version}\n")
            payload_hash = file_hash(directory / "module.txt")
            write_json(directory / "manifest.json", {"version": version, "moduleSha256": payload_hash, "immutable": True})
            (directory / "module.txt").chmod(0o444)
            (directory / "manifest.json").chmod(0o444)
        current = self.root / "install/current"
        current.symlink_to(Path("versions/v1"), target_is_directory=True)
        write_json(self.root / "control/updater-lease.json", {"owner": "qualification-updater", "scope": profile, "variant": self.variant})
        write_json(self.root / "control/checkpoint.json", {"current": "v1", "tag": f"refs/tags/qualification-checkpoint-{self.repetition}", "variant": self.variant})
        if profile == "bundle-provenance":
            write_json(self.root / "control/bundle-provenance.json", {
                "repository": "synthetic-local-staging", "ref": f"refs/heads/{self.branch}",
                "commit": git_text(self.root, staging, ["rev-parse", "HEAD"]),
                "tree": git_text(self.root, staging, ["rev-parse", "HEAD^{tree}"]),
                "variant": self.variant,
            })
        if profile == "dependency-activation":
            write_json(self.root / "control/dependency-graph.json", {
                "provider": "provider.v2", "consumers": ["consumer.a", "consumer.b"],
                "activeLeases": 2 if "active-leases" in self.variant else 0,
                "contractEvidenceRequired": True, "variant": self.variant,
            })
        self.blockers.append("OS-separated updater authority and candidate self-update controller required")

    def build_hosted_spec(self, profile: str) -> None:
        write_json(self.root / "control/hosted-spec.json", {
            "schemaVersion": "bridlewise-hosted-git-spec/v1",
            "profile": profile, "variant": self.variant,
            "endpoint": None, "credentialCapability": None,
            "requiredGrant": ["provider", "tenant", "repository", "disposableMarker", "allowedRefs", "expiry", "cleanup"],
            "networkMutation": False,
        })
        self.blockers.append("authorized disposable hosted remote grant and external adapter required")


def find_scenario(catalog: Mapping[str, Any], scenario_id: str) -> Mapping[str, Any]:
    for scenario in catalog["scenarios"]:
        if scenario["id"] == scenario_id:
            return scenario
    raise QualificationError(f"unknown scenario: {scenario_id}")


def prepare_destination(destination: Path) -> None:
    if destination.exists():
        if not destination.is_dir() or any(destination.iterdir()):
            raise QualificationError(f"destination must be absent or empty: {destination}")
    else:
        destination.mkdir(parents=True)


def generate_fixture(destination: Path, scenario: Mapping[str, Any], repetition: int) -> dict[str, Any]:
    if repetition < 1:
        raise QualificationError("repetition must be positive")
    prepare_destination(destination)
    return FixtureBuilder(destination, scenario, repetition).build()


def validate_catalog(catalog: Mapping[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    if catalog.get("schemaVersion") != "bridlewise-git-qualification-catalog/v1":
        errors.append("unexpected catalog schemaVersion")
    scenarios = catalog.get("scenarios")
    if not isinstance(scenarios, list) or not scenarios:
        errors.append("catalog scenarios must be a non-empty array")
        scenarios = []
    identifiers: set[str] = set()
    observed_coverage: set[str] = set()
    layers: dict[str, int] = {}
    for index, scenario in enumerate(scenarios):
        prefix = f"scenario[{index}]"
        identifier = scenario.get("id")
        if not isinstance(identifier, str) or not re.fullmatch(r"GIT-[A-Z]+-[0-9]{3}", identifier):
            errors.append(f"{prefix}: invalid id")
            continue
        if identifier in identifiers:
            errors.append(f"{identifier}: duplicate id")
        identifiers.add(identifier)
        requirements = scenario.get("requirements", [])
        for required in ("USR-043", "DER-029"):
            if required not in requirements:
                errors.append(f"{identifier}: missing {required} binding")
        repetitions = scenario.get("repetitions", {})
        variants = repetitions.get("variants", [])
        minimum = repetitions.get("minimum")
        if not isinstance(minimum, int) or minimum < 3:
            errors.append(f"{identifier}: minimum repetitions below three")
        if not isinstance(variants, list) or len(variants) < 3 or len(set(variants)) != len(variants):
            errors.append(f"{identifier}: requires at least three unique material variants")
        oracle = scenario.get("oracle", {})
        if oracle.get("implementation") != ORACLE_VERSION or oracle.get("objectGraphRequired") is not True:
            errors.append(f"{identifier}: independent object graph oracle not bound")
        if not oracle.get("postconditions"):
            errors.append(f"{identifier}: missing independent postconditions")
        execution = scenario.get("execution", {})
        if execution.get("networkMutation") is not False:
            errors.append(f"{identifier}: repository catalog may not enable network mutation")
        layer = execution.get("layer", "missing")
        layers[layer] = layers.get(layer, 0) + 1
        coverage = scenario.get("coverage", [])
        observed_coverage.update(coverage)
    claims = set(catalog.get("coverageClaims", []))
    missing_claims = claims - observed_coverage
    undeclared = observed_coverage - claims
    if missing_claims:
        errors.append(f"coverage claims not represented: {sorted(missing_claims)}")
    if undeclared:
        errors.append(f"scenario coverage not declared: {sorted(undeclared)}")
    if errors:
        raise QualificationError("catalog validation failed:\n- " + "\n- ".join(errors))
    return {
        "schemaVersion": catalog["schemaVersion"],
        "scenarioCount": len(scenarios),
        "coverageCount": len(claims),
        "layers": dict(sorted(layers.items())),
        "catalogSha256": file_hash(CATALOG_PATH),
    }


def validate_sources(source_lock: Mapping[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    checked = 0
    for source in source_lock.get("localGovernedInputs", []):
        path = REPOSITORY_ROOT / source["path"]
        if not path.is_file():
            errors.append(f"missing governed input: {source['path']}")
            continue
        actual = file_hash(path)
        if actual != source["fileSha256"]:
            errors.append(f"stale governed input identity: {source['path']}")
        if "lineRange" in source:
            start_text, end_text = source["lineRange"].split("-", 1)
            lines = path.read_bytes().splitlines(keepends=True)
            selected = b"".join(lines[int(start_text) - 1:int(end_text)])
            range_hash = hashlib.sha256(selected).hexdigest()
            if range_hash != source["rangeSha256"]:
                errors.append(f"stale governed range identity: {source['identity']}")
        checked += 1
    if errors:
        raise QualificationError("source lock validation failed:\n- " + "\n- ".join(errors))
    return {"localSourcesChecked": checked, "sourcesLockSha256": file_hash(SOURCES_PATH)}


def validate_suite(*, verify_manifest_too: bool = False) -> dict[str, Any]:
    catalog = load_json(CATALOG_PATH)
    result = {
        "catalog": validate_catalog(catalog),
        "sources": validate_sources(load_json(SOURCES_PATH)),
        "schemas": {},
    }
    for path in sorted(SCHEMA_ROOT.glob("*.json")):
        load_json(path)
        result["schemas"][path.name] = file_hash(path)
    if set(result["schemas"]) != {
        "candidate-exchange.schema.json",
        "qualification-receipt.schema.json",
        "scenario-catalog.schema.json",
    }:
        raise QualificationError("exact qualification schema set is missing or ambiguous")
    if verify_manifest_too:
        result["manifest"] = verify_manifest()
    return result


def probe_preflight() -> dict[str, Any]:
    git_executable = shutil.which("git")
    if git_executable is None:
        return {
            "schemaVersion": "bridlewise-git-preflight/v1",
            "status": "blocked",
            "capabilities": {"git.executable": {"status": "missing"}},
            "blockers": ["Git is not installed; use the official Git install source and rerun behavioral probes."],
        }
    capabilities: dict[str, Any] = {}
    blockers: list[str] = []

    def record(identifier: str, function: Any) -> None:
        try:
            evidence = function()
            capabilities[identifier] = {"status": "available", "evidence": evidence}
        except Exception as error:  # probe must continue to expose all blockers
            capabilities[identifier] = {"status": "missing-or-failed", "errorClass": error.__class__.__name__}
            blockers.append(identifier)

    version = run_process([git_executable, "--version"], check=True).stdout.decode("ascii", "replace").strip()
    capabilities["git.executable"] = {"status": "available", "evidence": version}
    with tempfile.TemporaryDirectory(prefix="bridlewise-git-preflight-") as temporary:
        root = Path(temporary)
        repo = root / "workspace"
        init_repository(root, repo, "main")
        head = commit_changes(root, repo, 1, 1, "probe", {"probe.txt": "probe\n"})
        record("git.status-porcelain-v2", lambda: git_text(root, repo, ["status", "--porcelain=v2", "--branch"]).splitlines()[0])
        record("git.fsck", lambda: git_text(root, repo, ["fsck", "--strict", "--no-progress"]) or "clean")

        def probe_worktree() -> str:
            git(root, repo, ["branch", "probe-worktree"])
            target = root / "peers/worktree"
            git(root, repo, ["worktree", "add", "--quiet", str(target), "probe-worktree"])
            value = git_text(root, target, ["rev-parse", "--git-common-dir"])
            git(root, repo, ["worktree", "remove", "--force", str(target)])
            return sanitize_text(value, root)

        record("git.worktree", probe_worktree)

        def probe_update_ref() -> str:
            zero = "0" * len(head)
            program = (
                f"start\nupdate refs/qualification/a {head} {zero}\n"
                f"update refs/qualification/b {head} {zero}\nprepare\ncommit\n"
            ).encode("ascii")
            git(root, repo, ["update-ref", "--stdin"], input_bytes=program)
            refs = git_text(root, repo, ["show-ref", "refs/qualification/a", "refs/qualification/b"])
            return hashlib.sha256(refs.encode()).hexdigest()

        record("git.update-ref-transaction", probe_update_ref)
        remote = root / "remotes/destination.git"
        init_repository(root, remote, "main", bare=True)

        def probe_atomic_push() -> str:
            git(root, repo, ["push", "--atomic", str(remote), "refs/qualification/a:refs/qualification/a", "refs/qualification/b:refs/qualification/b"])
            return git_text(root, remote, ["show-ref", "refs/qualification/a", "refs/qualification/b"])

        record("git.push-atomic", probe_atomic_push)

        def probe_atomic_fetch() -> str:
            target = root / "peers/fetch"
            init_repository(root, target, "main")
            git(root, target, ["fetch", "--atomic", str(remote), "+refs/qualification/*:refs/qualification/*"])
            return git_text(root, target, ["show-ref", "refs/qualification/a", "refs/qualification/b"])

        record("git.fetch-atomic", probe_atomic_fetch)
        source, _ = create_bare_remote(root, "clone-source", 1, commits=4, branch="main")

        def probe_shallow() -> str:
            target = root / "peers/shallow"
            clone_local(root, source, target, 1, "--depth=1", "--single-branch")
            return git_text(root, target, ["rev-parse", "--is-shallow-repository"])

        record("git.clone-shallow", probe_shallow)

        def probe_partial() -> str:
            git(root, source, ["config", "uploadpack.allowFilter", "true"])
            target = root / "peers/partial"
            clone_local(root, source, target, 1, "--filter=blob:none", "--no-checkout")
            return git_text(root, target, ["config", "--get", "remote.origin.promisor"])

        record("git.clone-filter", probe_partial)

        def probe_symlink() -> str:
            target = root / "control/symlink-target"
            link = root / "control/symlink"
            write_text(target, "target\n")
            os.symlink(target, link)
            return "supported" if link.is_symlink() else "not-symlink"

        record("filesystem.symlink", probe_symlink)

        def probe_hardlink() -> str:
            source_file = root / "control/hardlink-source"
            target_file = root / "control/hardlink-target"
            write_text(source_file, "source\n")
            os.link(source_file, target_file)
            return "same-inode" if source_file.stat().st_ino == target_file.stat().st_ino else "different-inode"

        record("filesystem.hardlink", probe_hardlink)

        def probe_case() -> str:
            upper = root / "control/CaseProbe"
            lower = root / "control/caseprobe"
            write_text(upper, "upper\n")
            write_text(lower, "lower\n")
            return "case-sensitive" if upper.read_text() != lower.read_text() else "case-folding"

        record("filesystem.case-behavior", probe_case)

    optional = {
        "git-lfs.version": (["git-lfs", "version"], "Install from the official Git LFS 3.7.1 release; verify with `git lfs version` and a local `git lfs fsck`."),
        "gpg.version": (["gpg", "--version"], "Provision an approved disposable test signer; verify a signed commit/push in a disposable repository."),
        "ssh-keygen.version": (["ssh-keygen", "-V"], "Install the platform OpenSSH client and verify an approved disposable signing/agent capability."),
    }
    for identifier, (command, instruction) in optional.items():
        executable = shutil.which(command[0])
        if executable is None:
            capabilities[identifier] = {"status": "missing", "verification": instruction}
            blockers.append(identifier)
            continue
        completed = run_process([executable, *command[1:]], check=False)
        # ssh-keygen -V requires an argument and can return non-zero while still
        # proving executable presence; the command identity is the evidence.
        capabilities[identifier] = {
            "status": "available-executable-unqualified",
            "returncode": completed.returncode,
            "verification": instruction,
        }
    researched = load_json(SOURCES_PATH)
    return {
        "schemaVersion": "bridlewise-git-preflight/v1",
        "status": "blocked" if blockers else "capabilities-observed-not-qualified",
        "observedGitVersion": version,
        "researchedGitRelease": researched["git"]["release"],
        "researchedGitCommit": researched["git"]["peeledCommit"],
        "capabilities": dict(sorted(capabilities.items())),
        "blockers": sorted(set(blockers)),
        "readinessClaim": False,
    }


def verify_manifest() -> dict[str, Any]:
    if not MANIFEST_PATH.is_file():
        raise QualificationError("MANIFEST.json is missing")
    manifest = load_json(MANIFEST_PATH)
    errors: list[str] = []
    for entry in manifest.get("files", []):
        path = REPOSITORY_ROOT / entry["path"]
        if not path.is_file():
            errors.append(f"missing: {entry['path']}")
        elif file_hash(path) != entry["sha256"]:
            errors.append(f"hash mismatch: {entry['path']}")
    if errors:
        raise QualificationError("manifest verification failed:\n- " + "\n- ".join(errors))
    if manifest.get("manifestSelfExcluded") is not True:
        raise QualificationError("manifest must explicitly exclude its own recursive hash")
    return {"filesVerified": len(manifest["files"]), "manifestSha256": file_hash(MANIFEST_PATH)}


def run_self_test(repetitions: int, selected: str | None = None) -> dict[str, Any]:
    if repetitions < 3:
        raise QualificationError("self-test requires at least three repetitions")
    catalog = load_json(CATALOG_PATH)
    validate_catalog(catalog)
    scenarios = [find_scenario(catalog, selected)] if selected else catalog["scenarios"]
    generated = 0
    captured = 0
    blocked: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    for scenario in scenarios:
        for repetition in range(1, repetitions + 1):
            try:
                with tempfile.TemporaryDirectory(prefix=f"{scenario['id'].lower()}-") as temporary:
                    root = Path(temporary)
                    fixture = generate_fixture(root, scenario, repetition)
                    generated += 1
                    oracle = inspect_fixture(root)
                    captured += 1
                    if len(oracle["graphSha256"]) != 64 or len(oracle["filesystemSha256"]) != 64:
                        raise QualificationError("oracle digest length invariant failed")
                    if fixture["blockers"]:
                        blocked.append({"scenarioId": scenario["id"], "repetition": repetition, "blockers": fixture["blockers"]})
            except Exception as error:
                failures.append({"scenarioId": scenario["id"], "repetition": repetition, "errorClass": error.__class__.__name__, "message": sanitize_text(str(error))[:500]})
    return {
        "schemaVersion": "bridlewise-git-fixture-self-test/v1",
        "scenarioCount": len(scenarios),
        "repetitionsPerScenario": repetitions,
        "fixturesGenerated": generated,
        "oracleCaptures": captured,
        "blockedFixtures": blocked,
        "failures": failures,
        "status": "failed" if failures else "fixture-layer-passed-candidate-unassessed",
        "readinessClaim": False,
    }


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("validate")
    commands.add_parser("preflight")
    generate = commands.add_parser("generate")
    generate.add_argument("--scenario", required=True)
    generate.add_argument("--repetition", required=True, type=int)
    generate.add_argument("--destination", required=True, type=Path)
    inspect = commands.add_parser("inspect")
    inspect.add_argument("--fixture", required=True, type=Path)
    self_test = commands.add_parser("self-test")
    self_test.add_argument("--repetitions", type=int, default=3)
    self_test.add_argument("--scenario")
    commands.add_parser("verify-manifest")
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "validate":
            value = validate_suite(verify_manifest_too=MANIFEST_PATH.exists())
        elif args.command == "preflight":
            value = probe_preflight()
        elif args.command == "generate":
            catalog = load_json(CATALOG_PATH)
            validate_catalog(catalog)
            value = generate_fixture(args.destination.resolve(), find_scenario(catalog, args.scenario), args.repetition)
        elif args.command == "inspect":
            value = inspect_fixture(args.fixture.resolve())
        elif args.command == "self-test":
            value = run_self_test(args.repetitions, args.scenario)
        elif args.command == "verify-manifest":
            value = verify_manifest()
        else:
            raise AssertionError(args.command)
        print(json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True))
        return 1 if value.get("status") == "failed" else 0
    except (QualificationError, GitCommandError, subprocess.TimeoutExpired, OSError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"status": "failed", "errorClass": error.__class__.__name__, "message": sanitize_text(str(error)), "readinessClaim": False}, indent=2, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
