#!/usr/bin/env python3
"""Summarize the raw MetricKit diagnostic that a Screenr MetricKit event attaches.

Usage:
  summarize_metrickit_diagnostic.py [--offline] FILE

FILE is a downloaded MXDiagnosticPayload.json attachment: one diagnostic's
jsonRepresentation(), whose callStackTree holds every sampled frame, or a
whole MXDiagnosticPayload, whose lists of diagnostics each hold one. For each
call stack, one per thread when callStackPerThread is true, it prints its
samples, the samples in each binary, its heaviest path, and every frame in
Screenr's binary with its offset and samples. A frame's samples include its
callees', and a root frame is the outermost caller. It finds Screenr's dSYM by
the binary's UUID in Sentry's screenr-ios project through the sentry CLI and
turns offsets into functions with atos; with --offline, or when either fails,
it prints the offsets and says why. It prints counts, binary names, offsets,
and function names, and nothing that identifies a member.
"""

import argparse
from collections import Counter
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from api_payload import payload  # noqa: E402

ORGANIZATION = "artisanal-software"
PROJECT = "screenr-ios"
APP_BINARY = "Screenr"
NO_BINARY = "(no binary)"
# A whole MXDiagnosticPayload's lists of diagnostics, in the order to print them, and their kinds.
PAYLOAD_LISTS = {"crashDiagnostics": "crash", "hangDiagnostics": "hang", "cpuExceptionDiagnostics": "CPU exception",
                 "diskWriteExceptionDiagnostics": "disk write exception", "appLaunchDiagnostics": "app launch"}
# A lone diagnostic names no kind, but the measurement in its metadata does.
KIND_KEYS = (("exceptionType", "crash"), ("signal", "crash"), ("hangDuration", "hang"),
             ("totalCPUTime", "CPU exception"), ("writesCaused", "disk write exception"),
             ("launchDuration", "app launch"))
MACH_O = {b"\xca\xfe\xba\xbe", b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf", b"\xce\xfa\xed\xfe", b"\xcf\xfa\xed\xfe"}
SAFE_ID = re.compile(r"[A-Za-z0-9_-]+", re.ASCII)
# atos repeats an offset outside the binary, and answers one inside it that no function covers with its address.
UNPLACED = re.compile(rf"0x[0-9A-Fa-f]+(?: \(in {APP_BINARY}\))?", re.ASCII)
# Terminal control characters, which an untrusted attachment could use to rewrite the output.
CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
LONGEST_VALUE = 200
SKIPPED_STACKS = "Skipped unreadable call stacks"
SKIPPED_FRAMES = "Skipped unreadable frames and their callees"
UNCOUNTED = "Counted as 0 samples, frames without a sample count"


class Unreadable(Exception):
    """A diagnostic, or the symbols for it, that this helper cannot read."""


class Frame:
    __slots__ = ("binary", "uuid", "offset", "samples", "children")

    def __init__(self, raw, notes):
        name = raw.get("binaryName")
        self.binary = text(name) if isinstance(name, str) and name else None
        self.uuid = debug_id(raw.get("binaryUUID"))
        self.offset = count(raw.get("offsetIntoBinaryTextSegment"))
        self.samples = count(raw.get("sampleCount"))
        if self.samples is None:
            notes[UNCOUNTED] += 1
            self.samples = 0
        self.children = []


def text(value):
    """Show a value on one line, without control characters, and cut to a readable length."""
    shown = CONTROL.sub("?", value)
    return shown if len(shown) <= LONGEST_VALUE else shown[:LONGEST_VALUE] + "…"


def count(value):
    """Return a JSON number that counts something, or None."""
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def debug_id(value):
    """Return a binary UUID in Sentry's debug ID form, lowercase with hyphens, or None."""
    if not isinstance(value, str):
        return None
    try:
        return str(uuid.UUID(value))
    except ValueError:
        return None


def hexadecimal(offset):
    return "0x?" if offset is None else f"0x{offset:x}"


def plural(number, noun):
    return f"{number} {noun}{'' if number == 1 else 's'}"


def diagnostics(document):
    """Return the file's diagnostics with their kinds, whether it holds one diagnostic or a whole payload."""
    if not isinstance(document, dict):
        raise Unreadable("holds no MetricKit diagnostic")
    if "callStackTree" in document:
        metadata = document.get("diagnosticMetaData")
        keys = metadata if isinstance(metadata, dict) else {}
        return [(next((kind for key, kind in KIND_KEYS if key in keys), "unknown kind"), document)]
    lists = [key for key in PAYLOAD_LISTS if key in document]
    lists += sorted(key for key in document if key.endswith("Diagnostics") and key not in PAYLOAD_LISTS)
    found = []
    for key in lists:
        if not isinstance(document[key], list):
            raise Unreadable(f"has a {key} that is not a list")
        found += [(PAYLOAD_LISTS.get(key, key.removesuffix("Diagnostics")), item) for item in document[key]]
    if not found:
        raise Unreadable("holds no MetricKit diagnostic")
    return found


def call_stacks(diagnostic, notes):
    """Parse a diagnostic's call stack tree, without recursion. Return whether it has one stack per thread, how
    many stacks it has, and each readable stack's index, whether MetricKit attributes the diagnostic to it, and
    its root frames."""
    tree = diagnostic.get("callStackTree") if isinstance(diagnostic, dict) else None
    stacks = tree.get("callStacks") if isinstance(tree, dict) else None
    if not isinstance(stacks, list):
        raise Unreadable("has a diagnostic without a readable callStackTree")
    parsed = []
    for index, stack in enumerate(stacks):
        raw_roots = stack.get("callStackRootFrames") if isinstance(stack, dict) else None
        if not isinstance(raw_roots, list):
            notes[SKIPPED_STACKS] += 1
            continue
        roots = []
        pending = [(raw, roots) for raw in reversed(raw_roots)]
        while pending:
            raw, siblings = pending.pop()
            subframes = raw.get("subFrames", []) if isinstance(raw, dict) else None
            if not isinstance(subframes, list):
                notes[SKIPPED_FRAMES] += 1
                continue
            frame = Frame(raw, notes)
            siblings.append(frame)
            pending += [(sub, frame.children) for sub in reversed(subframes)]
        parsed.append((index, stack.get("threadAttributed") is True, roots))
    return tree.get("callStackPerThread") is True, len(stacks), parsed


def walk(roots):
    """Yield every frame below the roots."""
    work = list(roots)
    while work:
        frame = work.pop()
        yield frame
        work += frame.children


def tally(roots):
    """Count a call stack's frames and samples: by binary, and by Screenr frame."""
    frames = 0
    own_by_binary, stack_by_binary = Counter(), Counter()
    # (UUID, offset) -> [samples anywhere on the stack, samples in the frame itself]
    mine = {}
    binaries_on_path, mine_on_path = Counter(), Counter()
    work = [(False, frame) for frame in reversed(roots)]
    while work:
        leaving, frame = work.pop()
        binary = frame.binary or NO_BINARY
        key = (frame.uuid, frame.offset)
        if leaving:
            binaries_on_path[binary] -= 1
            if frame.binary == APP_BINARY:
                mine_on_path[key] -= 1
            continue
        frames += 1
        own = max(frame.samples - sum(child.samples for child in frame.children), 0)
        own_by_binary[binary] += own
        # A sample counts once for a binary, or a frame, that calls into itself.
        if not binaries_on_path[binary]:
            stack_by_binary[binary] += frame.samples
        binaries_on_path[binary] += 1
        if frame.binary == APP_BINARY:
            counts = mine.setdefault(key, [0, 0])
            if not mine_on_path[key]:
                counts[0] += frame.samples
            counts[1] += own
            mine_on_path[key] += 1
        work.append((True, frame))
        work += [(False, child) for child in reversed(frame.children)]
    return frames, own_by_binary, stack_by_binary, mine


def heaviest_path(roots):
    """Follow the frame with the most samples at each level, the first one on a tie."""
    path, level = [], roots
    while level:
        frame = max(level, key=lambda candidate: candidate.samples)
        path.append(frame)
        level = frame.children
    return path


def run(command, **options):
    return subprocess.run(command, capture_output=True, check=False, **options)


def failure(result, what):
    lines = [line for line in result.stderr.decode("utf-8", "replace").splitlines() if line.strip()]
    detail = f": {text(lines[-1].strip())}" if lines else ""
    return f"{what} failed with exit status {result.returncode}{detail}"


def dwarf(record):
    """Report whether a Sentry debug file is a dSYM, with debug information, rather than an executable."""
    data = record.get("data") if isinstance(record.get("data"), dict) else {}
    features = data.get("features") if isinstance(data.get("features"), list) else []
    return data.get("type") == "dbg" or "debug" in features


def debug_file(sentry, binary_uuid, directory):
    """Download the debug file that Sentry holds for a UUID, a dSYM when it has one. Return its path and source."""
    endpoint = f"projects/{ORGANIZATION}/{PROJECT}/files/dsyms/"
    result = run([sentry, "api", f"{endpoint}?debug_id={binary_uuid}", "--json"])
    if result.returncode != 0:
        raise Unreadable(failure(result, "listing Sentry's debug files"))
    try:
        response = json.loads(result.stdout)
    except ValueError:
        raise Unreadable("Sentry's debug file list is not JSON") from None
    try:
        records = payload(response, "debug files")
    except ValueError as error:
        raise Unreadable(f"Sentry's debug file list is unreadable: {error}") from None
    usable = [record for record in records if isinstance(record.get("id"), (str, int))
              and not isinstance(record["id"], bool) and SAFE_ID.fullmatch(str(record["id"]))]
    if not usable:
        raise Unreadable("Sentry holds no debug file for it")
    # Sentry lists the newest file first, which may be an executable with only its symbol table.
    record = min(usable, key=lambda candidate: not dwarf(candidate))
    path = directory / binary_uuid / APP_BINARY
    path.parent.mkdir()
    with open(path, "wb") as stream:
        result = subprocess.run([sentry, "api", f"{endpoint}?id={record['id']}"], stdout=stream,
                                stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        raise Unreadable(failure(result, f"downloading Sentry's debug file {record['id']}"))
    with open(path, "rb") as stream:
        if stream.read(4) not in MACH_O:
            raise Unreadable(f"Sentry's debug file {record['id']} is not a Mach-O file")
    kind = "a dSYM" if dwarf(record) else "an executable with only its symbol table"
    return path, f"Sentry's debug file {record['id']}, {kind}"


def symbolicate(atos, path, offsets):
    """Turn offsets into functions with atos. Return the functions it placed, by offset."""
    ordered = sorted(offsets)
    asked = [hexadecimal(offset) for offset in ordered]
    result = run([atos, "-o", str(path), "-offset"], input=("\n".join(asked) + "\n").encode())
    if result.returncode != 0:
        raise Unreadable(failure(result, "atos"))
    lines = result.stdout.decode("utf-8", "replace").splitlines()
    if len(lines) != len(asked):
        raise Unreadable(f"atos answered {len(lines)} lines for {plural(len(asked), 'offset')}")
    functions = {}
    for offset, answer in zip(ordered, lines):
        answer = answer.strip()
        if answer and not UNPLACED.fullmatch(answer):
            functions[offset] = text(re.sub(rf" \(in {APP_BINARY}\)", "", answer, count=1))
    return functions


def symbols(stacks, offline):
    """Look up the functions of Screenr's frames. Return them by (UUID, offset), and a status line for each UUID."""
    offsets = {}
    for frame in walk(root for roots in stacks for root in roots):
        if frame.binary == APP_BINARY and frame.uuid and frame.offset is not None:
            offsets.setdefault(frame.uuid, set()).add(frame.offset)
    if not offsets:
        return {}, [f"Symbols: no {APP_BINARY} frame has both a binary UUID and an offset."]
    found, status = {}, []
    sentry = os.environ.get("SENTRY_BIN") or shutil.which("sentry")
    atos = shutil.which("atos")
    with tempfile.TemporaryDirectory(prefix="screenr-dsym-") as scratch:
        for binary_uuid, wanted in sorted(offsets.items()):
            prefix = f"Symbols for {APP_BINARY} {binary_uuid}"
            try:
                if offline:
                    raise Unreadable("not looked up with --offline")
                if not sentry:
                    raise Unreadable("the sentry CLI is not on PATH")
                if not atos:
                    raise Unreadable("atos is not on PATH; it comes with Xcode")
                path, source = debug_file(sentry, binary_uuid, Path(scratch))
                functions = symbolicate(atos, path, wanted)
            except Unreadable as reason:
                status.append(f"{prefix}: unavailable, {reason}; showing offsets only")
                continue
            found.update(((binary_uuid, offset), function) for offset, function in functions.items())
            status.append(f"{prefix}: {source}; atos placed {len(functions)} of {plural(len(wanted), 'offset')}")
    return found, status


def summarize(label, roots, functions):
    frames, own_by_binary, stack_by_binary, mine = tally(roots)
    print(f"  {label}: {plural(sum(root.samples for root in roots), 'sample')}, {plural(frames, 'frame')}")
    if not frames:
        return
    print("    Samples by binary, in its own frames and anywhere on the stack:")
    for binary in sorted(stack_by_binary, key=lambda name: (-own_by_binary[name], -stack_by_binary[name], name)):
        print(f"      {binary}  {own_by_binary[binary]} own, {stack_by_binary[binary]} on the stack")
    path = heaviest_path(roots)
    print(f"    Heaviest path, outermost first, {plural(len(path), 'frame')}:")
    for depth, frame in enumerate(path):
        function = functions.get((frame.uuid, frame.offset)) if frame.binary == APP_BINARY else None
        print(f"      {depth:>3}  {frame.binary or NO_BINARY}  {hexadecimal(frame.offset)}  {frame.samples}"
              + (f"  {function}" if function else ""))
    if not mine:
        print(f"    {APP_BINARY} frames: none")
        return
    print(f"    {APP_BINARY} frames, {plural(len(mine), 'offset')}, most samples on the stack first:")
    for key, (on_stack, own) in sorted(mine.items(), key=lambda item: (-item[1][0], -item[1][1], item[0][1] or 0)):
        function = functions.get(key)
        print(f"      {hexadecimal(key[1])}  {on_stack} on the stack, {own} own"
              + (f"  {function}" if function else ""))


def main():
    parser = argparse.ArgumentParser(prog="summarize_metrickit_diagnostic.py", description=__doc__.splitlines()[0])
    parser.add_argument("--offline", action="store_true", help="show offsets without looking up Screenr's dSYM")
    parser.add_argument("file", type=Path, metavar="FILE")
    args = parser.parse_args()
    if not args.file.is_file():
        parser.error(f"no such diagnostic: {args.file}")
    try:
        document = json.loads(args.file.read_bytes())
    except (ValueError, RecursionError):  # Bytes that are not JSON, or nesting deeper than Python parses.
        print(f"Error: {args.file} is not readable JSON", file=sys.stderr)
        return 1
    parsed = []
    try:
        for kind, diagnostic in diagnostics(document):
            notes = Counter()
            parsed.append((kind, notes, *call_stacks(diagnostic, notes)))
    except Unreadable as reason:
        print(f"Error: {args.file} {reason}", file=sys.stderr)
        return 1

    print(f"{args.file.name}: {plural(len(parsed), 'diagnostic')}")
    functions, status = symbols([roots for *_, stacks in parsed for *_, roots in stacks], args.offline)
    for line in status:
        print(line)
    for number, (kind, notes, per_thread, size, stacks) in enumerate(parsed, start=1):
        shape = "one per thread" if per_thread else "all threads together"
        print(f"Diagnostic {number} of {len(parsed)}, {kind}: {plural(size, 'call stack')}, {shape}")
        for note, times in sorted(notes.items()):
            print(f"  {note}: {times}")
        for index, attributed, roots in stacks:
            # Sentry numbers a MetricKit event's threads the same way.
            label = f"Thread {index}" if per_thread else f"Call stack {index}"
            summarize(label + (", attributed" if attributed else ""), roots, functions)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except OSError as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
