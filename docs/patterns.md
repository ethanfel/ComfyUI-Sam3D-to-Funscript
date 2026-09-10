# Gap filling and generated patterns

Motion Studio has **Fill gaps & generate patterns** just above the main curve. It works in the embedded editor, the shared workspace and downloaded offline viewers. No model inference or extra dependency is required.

1. Select **Main** and the axis you want to edit, or click **Edit** on a source track.
2. Shift-drag a range on its curve, or set **In** and **Out**. For insertion, seek to a starting time, enter **Duration**, then click **Set range at playhead**.
3. Choose a tool and click **Preview replacement**. A dashed pink curve shows the candidate. Changing its controls updates the preview after a short delay.
4. Click **Apply to Main · L0** (or the named source/axis). **Undo** restores the previous curve. **Discard preview** makes no edit.

Replacement occupies the selected video interval: timestamps outside it do not move. The selected curve's endpoint values and outside actions are preserved, apart from rounding at newly sampled boundaries to the funscript's integer positions. It edits the displayed axis only. The existing **Copy selection · all axes** operation still copies matching source axes into main.

To keep a separate pattern row, use **Add track**, name the new row, and generate on it. Source rows keep independent scripts; use their copy controls to assemble the result into main.

## Continue surrounding motion

Use this for a short interval where tracking stops, a fleeting cut interrupts an otherwise repeating movement, or the extracted curve is corrupted. Select the whole unwanted portion with its endpoints on usable motion.

- **Both sides** estimates the rhythm before and after the selection. **Before the gap** and **After the gap** use only the chosen side.
- **Context per side** controls how many seconds to examine. Start with four seconds and expand it for slower motion. Automatic detection needs roughly two cycles; a manual cycle override needs at least one and a half cycles.
- **Cycle override** is in seconds. Zero estimates it from the curve. An override still needs repeating movement in the available context.
- **Join at each edge** controls the transition into and out of the replacement. The default is 150 ms. This join uses the outside endpoints and slopes; corrupted samples inside the selection do not influence it.

The estimate samples each available outside window, detects repetition and fits a trend plus three harmonics. It joins the left and right phases, amplitudes and centers through the gap. Joining phases avoids the amplitude cancellation that a crossfade between opposite waveforms could cause. If only one side has a usable rhythm, it uses that side and reports it. Without a usable repeating signal, it asks for more context, an override or a generated pattern.

The reported **rhythm fit** describes how well the periodic model explains that context. It is not tracking accuracy or evidence of motion hidden by a cut. The replacement is synthesized: long gaps, changed activities, noisy motion and irregular cycles require review. Harmonic fitting approximates the neighboring shape rather than reproducing every small feature. The editor never fills gaps automatically just because a scene marker exists.

## Generate pattern

The 14 names and mathematical shapes follow the supplied `Pattern_Generation/main.lua`, credited there to **Nerfarious837**: Heartbeat, Jigsaw, Jigsaw Squiggle, Pulse, Ramp Down, Ramp Up, Random, River Bed Center/High/Low, Sine Squiggle, Sine Wave, Square and Triangle. This implementation runs in Motion Studio; it does not execute Lua or require OpenFunscripter.

- Set **Cycle length**, **Amplitude** (distance from center), **Center** and **Reverse waveform**.
- **Fade in/out** taper the waveform amplitude toward its center. Overlapping fades use the smaller envelope.
- **Random seed** keeps the random preview repeatable: applying it uses exactly the previewed points.
- **Point spacing** is the maximum sampling interval in milliseconds. Faster shapes add points to retain their detail. A preview is limited to 100,000 points; use a shorter interval or larger spacing for large edits.
- **Join at each edge** blends to the authored boundary values. Zero disables the join span but still preserves those boundary values.

As in the supplied pack, Heartbeat and Sine Wave are identical. The Pulse, Square, Squiggle and River Bed formulas use their original frequency multipliers, so their cycle control is a scale parameter rather than necessarily one visible oscillation. Ramps span the complete selected duration. Random values depend on both seed and point spacing.

Generated values are bounded to 0–100. If amplitude and center would exceed that range, the preview reports clipping; reduce amplitude or move the center to avoid flattened extrema. Generation does not apply device-specific speed limits. Existing device output controls can compare the authored main against a selected device profile.

## Editing and persistence

Previews are temporary and local to the view: they do not change exports, simulator playback or the other editor until applied. Applied curves use the existing shared editing session, downloads and locks. A locked track cannot be changed by either tool. Changing the selected range, axis, track, authored curve or incoming project invalidates a pending preview.

Lock finished curves to preserve them across workflow reruns. An unlocked generated curve follows the same rerun behavior as other manual edits. Downloaded projects contain the applied actions, and downloaded viewers include both editing tools with no network requirement. Previously downloaded viewers keep the version of the tools bundled when they were exported.
