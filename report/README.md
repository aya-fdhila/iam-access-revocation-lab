# Technical Report

The completed report is [report.md](report.md). Its experimental numbers are indexed in
[evidence-summary.json](evidence-summary.json), which is derived deterministically from the three
canonical CSV files in `results/`.

After collecting new evidence, run `make export` to validate the CSV protocol, regenerate the
figures, and refresh the evidence summary. Then update the values beside the matching
`<!-- metric:... -->` markers in `report/report.md` and `docs/demo-script.md`. Run `make check`
last; it refuses a stale ledger, missing or unknown markers, and prose values that do not match the
canonical CSV evidence.
