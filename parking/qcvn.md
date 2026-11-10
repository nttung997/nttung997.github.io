# QCVN 40 and ghép ngang

Notes for the parallel-parking check in [`parking.js`](parking.js). This is the yard geometry from the national technical regulation, not the scoring circular.

## Standard

**QCVN 40:2024/BGTVT** — *Quy chuẩn kỹ thuật quốc gia về trung tâm sát hạch lái xe cơ giới đường bộ* (National technical regulation on road motor vehicle driving test centres).

- Drafted by Cục Đường bộ Việt Nam, appraised by Bộ Khoa học và Công nghệ, issued by the Minister of Transport in **Thông tư 49/2024/TT-BGTVT** of 15 November 2024.
- **Replaces QCVN 40:2015/BGTVT** (Thông tư 79/2015/TT-BGTVT of 10 December 2015). The 2015 text used the old car classes B1 and B2. The parking formulas below are the same; the class name in the current text is hạng B.
- Scope (clause 1.1): technical requirements for facilities, vehicles, and equipment of a driving-test centre. It sizes the figures on the yard. It does not list the point deductions.

## Symbols

Clause 2.1.15, for the car figures:

| Symbol | Meaning |
| --- | --- |
| `a` | Overall length of the test car, metres |
| `b` | Overall width of the test car, metres |
| `B1` | Width of the rear wheel on the passenger side, metres |
| `Rqv` | Minimum turning radius of the outer front-wheel track, metres |

## Test car, hạng B

Clause 2.2.5. A hạng B test car is a passenger car with 3 to 8 seats besides the driver, and at least:

| Dimension | Minimum |
| --- | --- |
| Overall length | 4.2 m |
| Overall width | 1.6 m |
| Wheelbase | 2.4 m |
| Outer front-wheel turning radius | 4.9 m |

The car in `parking.js` is a Vios: `a = 4.425 m`, `b = 1.73 m`, wheelbase `2.55 m`, rear overhang `0.965 m`. That sits inside those minima.

## Ghép xe ngang, hạng B

Clause **2.1.15.8** (Hình 13). The figure is on the right side of the lane, in the direction of travel, with a “Nơi đỗ xe” sign.

| Symbol | Name in the text | Formula |
| --- | --- | --- |
| `Lg` | Chiều dài nơi đỗ xe | `3a / 2` |
| `Rg` | Chiều rộng nơi đỗ xe | `5b / 4` |

For the sim car: **`Lg = 6.64 m`**, **`Rg = 2.16 m`**.

The clause does not say which side of the rectangle lies along the lane. This project reads `Lg` as the length along the kerb and `Rg` as the depth in from the lane, which is the parallel bay: one and a half car lengths long, one and a quarter car widths deep.

The sim does not use those values directly. It follows the bay measured on a reference yard photo (parallel bay beside a red-white kerb): painted rectangle **6.15 m × 2.05 m**, depth/length **0.333**, scaled by the yellow rear-wheel line 1 m in from the far end (48.5 px in the photo). That yard is a few per cent tighter than the QCVN minimums. The raised kerbs sit **0.25 m** outside the paint (measured 0.25–0.33 m), and a body corner has to reach the kerb face — 2 cm of contact tolerance — before a hit is scored.

Same `Lg` and `Rg` were in QCVN 40:2015 clause 2.2.1.11.8, then written for hạng B1 and B2.

### Other classes

Clause **2.1.15.9** (Hình 14), ghép ngang for hạng C, D1, D2, and D, also on the right side of the lane:

| Symbol | Formula |
| --- | --- |
| `Lg` | `5a / 3` |
| `Rg` | `5b / 4` |

The sim does not build this bay.

## Ghép xe dọc, for contrast

Clause **2.1.15.7** (Hình 12), hạng B and C1. Also on the right, with a “Nơi đỗ xe” sign.

| Symbol | Name in the text | Formula |
| --- | --- | --- |
| `Ld` | Chiều dài nơi ghép xe dọc | `a + 1.0 m` |
| `Rd` | Chiều rộng nơi ghép xe dọc | `b + 0.6 m` |
| `Ed` | Khoảng khống chế để lùi vào nơi đỗ | `1.2 a` |

For the sim car that is **5.5 m × 2.4 m**, with a 5.4 m approach zone. The old bay depth of 2.4 m was this `Rd`, not the ghép ngang width.

2015 clause 2.2.1.11.7 gave the same three formulas for hạng B and C.

## What this file does not take from QCVN

QCVN 40 sizes the painted figure. It does not define the beep. These checks in `parkedInSpec` come from how yards score the exercise, not from a clause in QCVN 40:

- Both kerb-side tyres within **25 cm** of the kerb line, and not on it.
- Both rear wheels past the yellow line painted **1 m** in from the far end of the bay (that inset is what the reference yard shows; it is not a QCVN dimension).
- Stopped, with the body and the tyres inside the lines.

Point losses (5 points for a wheel on a line, 5 points when the body is inside but the beep never comes, disqualification if part of the body is still outside at the end, the 2-minute clock) are in the practical-test scoring rules, not in QCVN 40.
