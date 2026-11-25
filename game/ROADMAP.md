# Skyhold roadmap

Endless shooter in `game/`. No build step, no runtime dependencies, static hosting only.

## Shipped

Six run-locked weapons (blaster, gravity, cryo, rad, asteroid belt, mines). Each ranks 1→5 and has one evolution. Passives are Phase rounds, Volatile rounds (mutually exclusive), and Emergency repair. Threat rises every 30s. A siege carrier arrives every fourth threat. Effects only, with a mute and a volume slider. Best score and settings persist. Installable, with an offline shell.

## Open

- More enemy and boss behaviour. One movement pattern and one boss today.
- Threat curve and spawn pacing. Balance is only checked to 300s.
- Absolute zero is still a thin Cryo evolution.
- Retention: meta-progression, seeds, a daily run, history.
- Feel: hit-stop, shake, richer effects, reduced motion, colorblind telegraphs.
- Split `game.js` only once it is hard to work in.

## Not doing

Multiplayer, accounts, a backend, a game engine, ads.

## Done means

A test covers the new behaviour, the README changes if play changes, and no runtime dependency is added.
