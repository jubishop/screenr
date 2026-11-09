"""The bound on a Python test's wait for a process that it starts.

A test waits for its process to exit, and this bound only ends a run that
hangs. Never size it for an idle Mac: while other checks ran in the same
checkout, load alone stretched a deploy harness run that takes half a second
past a 5-second bound (#552). See memory/process-test-waits.md.
"""

HANG_SECONDS = 180
