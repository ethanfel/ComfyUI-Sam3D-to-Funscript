# Project artwork

Original vector artwork using the project's existing schematic Handy 2 and SR6
geometry. The generator reads the device renderer without changing it.

| File | Use |
|---|---|
| [banner.svg](banner.svg) | README banner, 1280 × 480 |
| [social-preview.png](social-preview.png) | Social preview, 1280 × 640 |
| [social-preview.svg](social-preview.svg) | Editable vector source for the social preview |
| [build.mjs](build.mjs) | Rebuild both SVG compositions from the shared geometry |

The SVGs are self-contained: no scripts, external images, web fonts or animation.
The PNG has a solid background and is below 1 MB. To use it on GitHub, upload
`social-preview.png` in the repository's **Settings → Social preview**;
[GitHub's instructions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview)
cover the upload and recommended dimensions. Checking the file into the repository
does not automatically activate the social preview.

Rebuild from the repository root with Node.js and librsvg:

```bash
node assets/branding/build.mjs
rsvg-convert assets/branding/social-preview.svg -o assets/branding/social-preview.png
```

Artwork follows [GPL-3.0-only](../../LICENSE). Device names identify the schematic
models and do not imply manufacturer endorsement.
