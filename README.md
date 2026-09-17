# The Traitors — party game app

A mobile-first web app for playing a Traitors-style game with friends, each
on their own phone. Built as a static site (Netlify-ready) backed by
Firebase Firestore for shared, real-time game state, and Firebase
Anonymous Auth for per-player identity.

## What it does

- Host creates a game and gets a short join code; friends join with their name + the code.
- Host configures: starting traitor count, max traitors, phase lengths (investigation / banishment / night), the endgame player-count threshold, and what happens if a forced recruit doesn't respond in time.
- **Investigation phase**: free-form in-person mingling, app just shows a countdown.
- **Banishment phase**: discussion and vote happen in person; any player then taps who was banished into the app, which is logged immediately (with role revealed) to the shared "Eliminated" list.
- **Night phase**: players physically separate.
  - Traitors get a private in-app chat and a shared victim picker (whoever's selected when the timer runs out is the murder result).
  - If down to a single traitor, murder is replaced with a forced recruitment: the lone traitor picks a target, who privately gets an accept/decline prompt on their own phone with a countdown. Declining is logged exactly like an ordinary murder — no trace of the recruitment attempt.
  - At the end of the phase, each player privately sees either "Return to the game" or "You've been murdered by the Traitors" on their own screen.
- Two buttons on the home screen at all times: **Active players** and **Eliminated** (name, method, and revealed role).
- Once the game reaches your configured endgame threshold, the app shows a static hand-off screen and steps back — the endgame itself is played entirely in person, as agreed.

## 1. Create a Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and create a new project (the free Spark plan is enough for this).
2. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable.**
3. **Build → Firestore Database → Create database** (start in production mode — we ship our own rules below).
4. **Project settings (gear icon) → General → Your apps → Web (`</>`)**. Register an app (any nickname). Copy the `firebaseConfig` object it gives you.
5. Paste those values into `js/firebase-config.js` in this project, replacing the placeholders.

## 2. Deploy the Firestore security rules

The rules in `firestore.rules` are what keep a Faithful's device from being able to read anyone's secret role. Deploy them either:

- **Via the console**: Firestore → Rules tab → paste the contents of `firestore.rules` → Publish.
- **Via the CLI**: `npm install -g firebase-tools`, then `firebase login`, `firebase init firestore` (point it at this project and this rules file), then `firebase deploy --only firestore:rules`.

### Security model — please read

This is built for a **private game among friends**, not a public product. The rules stop a Faithful's app from reading another player's secret role (the important thing — it keeps the game honest) and keep the traitor chat private to traitors. They do **not** stop someone who opens dev tools and hand-edits requests from doing something like marking themselves alive again — there's no server-side referee, since that would require Cloud Functions (a paid-tier Firebase feature). For a living-room game this trade-off is normal and fine. If you ever want to harden it, the next step would be moving role assignment, elimination, and phase transitions into Cloud Functions instead of letting clients write that state directly.

## 3. Run it locally

Any static file server works, e.g.:

```bash
npx serve .
```

Then open the printed local URL on your phone (same Wi-Fi) or in a couple of browser tabs to test with "multiple players."

## 4. Deploy to Netlify with your domain

1. Push this folder to a GitHub repo (or drag-and-drop the folder into Netlify's deploy UI).
2. In Netlify: **Add new site → Import an existing project**, point it at the repo. No build command needed — this is a plain static site, so set the publish directory to the project root (`.`).
3. **Site settings → Domain management → Add a custom domain**, and follow Netlify's instructions to point your existing domain at it (usually a couple of DNS records with your registrar).
4. In Firebase, **Authentication → Settings → Authorized domains**, add your Netlify domain (and your custom domain) so anonymous sign-in is allowed from it.

## File overview

```
index.html          all screens (join, lobby, home, overlays, full-screen reveals)
css/style.css        mobile-first dark theme
js/firebase-config.js   your Firebase project credentials (fill this in)
js/app.js            all game logic: auth, Firestore sync, phase timers, night/recruit logic
firestore.rules      security rules — deploy these to your Firebase project
```

## Known limitations (fine for a living-room game, worth knowing)

- **Clock sync**: countdowns are computed from each phone's own clock against a shared end-time. If someone's phone clock is badly wrong, their countdown will be off. Not usually an issue in practice.
- **Elimination reveal depends on that player's phone being open**: the moment someone is murdered or banished, their *own* device is what reveals their role into the shared log and advances the game to the next phase (this is what keeps their role secret from everyone else until they choose to reveal it). If their phone is locked or the tab was closed at that exact moment, the game can stall until they reopen the app. In practice, whoever's just been eliminated will pick up their phone anyway.
- **No server-side referee**: see the security note above.
- If you want to reuse a game code, note codes aren't currently recycled or expired — each "Host a game" press generates a new one, so this isn't an issue in normal use.

## Possible next steps

- A "someone hasn't responded" nudge/banner for the lone-traitor recruit countdown, visible to the traitor.
- Sound/vibration cue when the night phase ends, since phones may be face-down.
- A lightweight "kick player" tool for the host during the lobby.
