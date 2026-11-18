# MetricKit diagnostics

A MetricKit event has the mechanism `mx_hang_diagnostic`,
`mx_cpu_exception`, or `mx_disk_write_exception`. For a hang, sentry-cocoa
flattens MetricKit's call tree into one frame list per thread, each frame
with a `parentIndex` and a `sampleCount`. Sentry trims a list over 250
frames: of a hang's 2,123 main-thread frames it kept the first 50 and the
last 200, and a `parentIndex` beyond the list shows the cut. Rebuild the
tree from the `rawStacktrace` frames, whose `parentIndex` values still
match, since symbolication can add inlined frames to `stacktrace`.

Every build that contains the change from
[#631](https://github.com/jubishop/screenr/issues/631), as
[builds and known fixes](screenr-correlation.md#builds-and-known-fixes)
tests, also attaches iOS's raw diagnostic, `MXDiagnosticPayload.json` in
sentry-cocoa 9.32.0, with the whole tree. Download it as
[attachments](screenr-correlation.md#attachments) says and summarize it:

```bash
python3 -I .agents/scripts/sentry-cli/summarize_metrickit_diagnostic.py \
  <dir>/attachments/MXDiagnosticPayload.json
```

For each thread it prints the samples by binary, the heaviest path, and every
frame in Screenr's binary, with the function that the build's dSYM in Sentry
names for its offset
([contract](../../../scripts/sentry-cli/README.md#metrickit-diagnostics)).
For a hang, read the main thread first: the one whose heaviest path starts
in `dyld`, Thread 0 in every hang seen so far. MetricKit's `attributed` mark
need not fall on it. When the helper says the symbols are unavailable, it
shows offsets alone; record why, and never guess a function from an offset.
When a MetricKit event from such a build lists no raw diagnostic, record that
the diagnostic failed to arrive.
