# Partial-person reference test

Open [partial_person_reference.json](partial_person_reference.json). The [API companion](partial_person_reference.api.json) uses the same settings. The source is preselected as `videos/general/2601102105_OC_00001.mp4`; no video is bundled.

Core **Load Video** feeds the streaming extractor, which analyses every frame, up to 1000 frames, in batches of 16 person crops. One extraction contains both person slots:

| Slot | Intended subject | Initial normalized `[x,y,width,height]` crop |
|---|---|---|
| 0 | Woman | `[0,0,1,0.91]` |
| 1 | Partial man | `[0,0.83,0.55,0.17]` |

These static crops are starting selections, not identity masks. SAM3D pads crops internally, so surrounding people can still influence its prediction. Leave `mask_video` disconnected: it replaces the two ROI slots with a single masked person. Adjust the crops if the inferred poses follow the wrong person.

Run the workflow and open Motion Studio. Its standalone and embedded views share one session with three source projects:

| Project | Motion | Use |
|---|---|---|
| `project_0` | Woman pelvis minus man pelvis, in camera coordinates | Initial main; test relative motion |
| `project_1` | Woman pelvis in camera coordinates | Baseline without the reference |
| `project_2` | Man pelvis in camera coordinates | Inspect the partial-person estimate |

Click **Edit** on `project_2` and review its yellow target marker and 3D pose throughout the clip. Then compare the other rows. All six channels are available, but a partial-body inference does not establish correct depth or orientation. `frame=camera` avoids relying on the man's unseen torso as the reference orientation. The indicated region has no dedicated SAM3D landmark; this test uses inferred pelvis motion.

Auto fits each source independently. Similar curve heights or a smooth curve do not establish accurate tracking. The person-presence flag is not a model confidence score. Reusing cached poses lets you change anchors and calibration without repeating inference; changing the person crops requires new inference.

The local run completed all 321 frames with two person slots, three source tracks and six output axes. Both a broad lower crop and this tighter lower-left crop still reconstructed a second pose on the woman in reviewed frames. The relative curve therefore does **not** establish a usable male reference. This workflow preserves the diagnostic setup; mask-conditioned person selection has not been tested here. Browser loading, save/reload, source selection and playback passed.

To check canvas loading, connection round trips and node spacing on an isolated server:

```bash
node scripts/workflows_browser_smoke.mjs http://127.0.0.1:8198 '' development/partial-person/browser tests/partial_person_reference.json
```
