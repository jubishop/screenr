#!/usr/bin/env python3
"""Hand bin/check-ios the Mac build slot that a build-slot wrapper took for it.

On a Mac that limits heavy Xcode and Swift jobs Mac-wide, xcodebuild and swift
on PATH are wrappers, links to a script named build-slots. A heavy call, such
as a build or a test run, takes one of the Mac's build slots, a flock lock, and
then runs the next xcodebuild or swift on PATH, which inherits the locked
descriptor, named in BUILD_SLOT_FD. In an unattended agent run the call first
waits for a free slot; after 45 minutes it gives up with status 75, naming the
holders. A nested call whose BUILD_SLOT_FD names a slot it inherited runs at
once.

bin/check-ios takes one slot for all its builds and tests, so that no step's
time limit counts a wait. It runs the wrapper as xcodebuild with this file
first on PATH under that name, so the wrapper takes the slot as it would for a
heavy call and then runs this file. This sends the inherited descriptor back
over the socket that CHANNEL names and stays until the check exits, as the
process that the slot's record names.
"""

import os
import socket
import sys

WRAPPER = "build-slots"
DESCRIPTOR = "BUILD_SLOT_FD"
CHANNEL = "SCREENR_BUILD_SLOT_CHANNEL"


def main():
    channel = socket.socket(fileno=int(os.environ.pop(CHANNEL)))
    try:
        slot = int(os.environ[DESCRIPTOR])
        os.fstat(slot)
    except (KeyError, ValueError, OSError):
        # The wrapper says when it could not take a slot and runs its tool without one.
        slot = None
    try:
        socket.send_fds(channel, [b"slot" if slot is not None else b"none"], [] if slot is None else [slot])
    except OSError:
        # The check has already stopped.
        return 1
    # The check's output may be a pipe that its caller reads to the end.
    quiet = os.open(os.devnull, os.O_RDWR)
    for stream in (0, 1, 2):
        os.dup2(quiet, stream)
    while channel.recv(1):
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
