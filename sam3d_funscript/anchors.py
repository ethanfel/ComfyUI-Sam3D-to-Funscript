"""General motion anchors and the complete named MHR70 landmark catalog.

Index convention: https://github.com/facebookresearch/sam-3d-body/blob/main/sam_3d_body/metadata/mhr70.py
"""

MHR70_NAMES = (
    "nose", "left_eye", "right_eye", "left_ear", "right_ear",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle",
    "left_big_toe_tip", "left_small_toe_tip", "left_heel",
    "right_big_toe_tip", "right_small_toe_tip", "right_heel",
    *(f"right_{finger}_{part}"
      for finger in ("thumb", "index", "middle", "ring", "pinky")
      for part in ("tip", "first_joint", "second_joint", "third_joint")),
    "right_wrist",
    *(f"left_{finger}_{part}"
      for finger in ("thumb", "index", "middle", "ring", "pinky")
      for part in ("tip", "first_joint", "second_joint", "third_joint")),
    "left_wrist", "left_olecranon", "right_olecranon",
    "left_cubital_fossa", "right_cubital_fossa", "left_acromion", "right_acromion", "neck",
)

# Preserve the original choices and default order in saved workflows.
ANCHORS = {"pelvis": (9, 10), "chest": (5, 6), "nose": (0,),
           "left_wrist": (62,), "right_wrist": (41,)}
ANCHORS.update({name: (index,) for index, name in enumerate(MHR70_NAMES)})
ANCHORS.update(left_hand=tuple(range(42, 63)), right_hand=tuple(range(21, 42)))
# Cache extension after MHR70: right and left outer mouth corners, respectively.
ANCHORS["mouth"] = (70, 71)

# Keep everyday controls short. Detailed landmarks remain valid in saved projects
# and API prompts, and are available through the optional selector node.
GENERAL_ANCHORS = (
    "pelvis", "chest", "nose", "left_wrist", "right_wrist",
    "left_hand", "right_hand", "neck", "mouth",
)
