# Pixel Pips website v19

Complete multi-page static website package for Pixel Pips.

Pages:
- Home
- My Pips
- Activate
- Market
- Floors
- Rewards
- Specials
- Docs
- Live
- Games (locked / coming soon)
- Contracts

The site uses a unified Game Boy Color inspired pixel-art visual system with separate HTML pages sharing the same CSS/JS shell.

The collection art direction is locked: 64×64 native grid, crisp nearest-neighbor scaling, deliberate dithering, single dark outline on collection art, 1px shadow shell, contact shadows, integer-snapped circles, round eyes, eye specular dots, outward ears, hand-drawn mouth bitmaps, minimum 2px antenna stem, forced-contrast anchor palette, unsnapped face hue, cold near-monochrome dormant state, full-color activated state, floor represented by background and tier represented by antenna.

Lore direction is Reception: pips are receivers, floors are channels, tier is signal strength, dormant is off, burning a unit switches it on. The site copy is written in that voice. Plain English, no leet-speak for Pixel Pips.

No Pixel Pips deployment address is hard coded before deployment. Official Pixel Pips contract addresses will be added only when deployed and verified.


## Games
- PIP CANNON is the first planned Pixel Pips game. It is currently locked and marked Coming Soon.


## DMG SFX v3
The site includes `audio/pixelpips-sfx.js`, a procedural Game Boy-style SFX engine. Every page has an SFX toggle and volume control. Preferences persist in localStorage.
