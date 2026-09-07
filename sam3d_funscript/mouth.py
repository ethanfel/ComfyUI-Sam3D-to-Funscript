"""Recover the mouth corners from native SAM3D output without another inference.

Goliath/Sapiens 308: 188 = right outer mouth corner, 189 = left outer corner.
Both precede the removed teeth indices, so their indices remain unchanged.
https://github.com/facebookresearch/sapiens/blob/main/pose/configs/_base_/datasets/goliath.py
"""

import numpy as np

MOUTH_KEYPOINTS = (188, 189)
MOUTH_NOTE = ("Mouth is the midpoint of SAM3D's reconstructed outer mouth corners. "
              "The base body model uses a neutral facial expression; mouth opening and contact are not measured.")


def mouth_regressor(sam3d_body_model):
    """Copy two rows of the already-loaded model's landmark mapping to CPU."""
    if sam3d_body_model is None:
        return None
    mapping = sam3d_body_model.model.head_pose.keypoint_mapping
    return mapping[list(MOUTH_KEYPOINTS)].detach().float().cpu().numpy().copy()


def mouth_corners(person, image_size, regressor=None):
    """Return camera-space corners and their image projections, or missing points.

    Native face output and the vertex/joint fallback use the same learned mapping.
    Only two 3D points and two 2D points are retained in the pose cache.
    """
    missing = (np.full((2, 3), np.nan, np.float32), np.full((2, 2), np.nan, np.float32))
    face = person.get("pred_face_keypoints_3d")
    if face is not None and np.asarray(face).shape == (238, 3):
        corners = np.asarray(face, dtype=np.float32)[np.array(MOUTH_KEYPOINTS) - 70]
    elif regressor is not None and person.get("pred_vertices") is not None and person.get("pred_joint_coords") is not None:
        vertices = np.asarray(person["pred_vertices"], dtype=np.float32)
        joints = np.asarray(person["pred_joint_coords"], dtype=np.float32)
        if vertices.ndim != 2 or joints.ndim != 2 or vertices.shape[1:] != (3,) or joints.shape[1:] != (3,):
            return missing
        if regressor.shape != (2, len(vertices) + len(joints)):
            raise ValueError("Mouth landmark mapping does not match the native mesh/joints; connect the same SAM3D model used for prediction.")
        # Both native buffers already use camera Y-down/Z-forward coordinates.
        corners = regressor[:, :len(vertices)] @ vertices + regressor[:, len(vertices):] @ joints
    else:
        return missing
    camera = person.get("pred_cam_t")
    focal = person.get("focal_length")
    if camera is None or focal is None:
        return missing
    points = corners + np.asarray(camera, dtype=np.float32).reshape(3)
    if not np.isfinite(points).all() or np.any(points[:, 2] <= 0):
        return missing
    f = float(np.asarray(focal).reshape(-1)[0])
    height, width = image_size
    pixels = points[:, :2] * f / points[:, 2:] + np.array([width / 2, height / 2], np.float32)
    if not np.isfinite(pixels).all():
        return missing
    return points.astype(np.float32), pixels.astype(np.float32)
