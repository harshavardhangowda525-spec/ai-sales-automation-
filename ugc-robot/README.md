# UGC robot: daily UGC ads on your Gemini subscription

Every day the backend queues the day's ad at 5 PM. This robot runs on a free Oracle Cloud machine
in a Chrome that you signed in to once. It:
1. asks **Gemini** to write a 3-scene UGC script and the caption;
2. makes **3 vertical clips** in **Google Flow**, using your subscription credits;
3. joins them into one ~36 s reel (1080×1920, 30 fps);
4. uploads it to the backend. Jarvis then calls you for approval, the preview goes to WhatsApp, and
   once you approve it posts at 7:30 PM.

There is no API key and no paid service. Your laptop can stay off.

> **Account risk (you accepted this):** Google's terms restrict automated use of its apps. Google may
> block the sign-in from a cloud machine or flag the account. Keep 2-step verification on, and never
> open the remote screen port to the internet; use the SSH tunnel below.

## 1. Create the free Oracle machine (once)

1. Sign up at **cloud.oracle.com** → "Start for free". A card is asked for verification only.
2. **Compute → Instances → Create instance**, then choose:
   - **Image:** Canonical Ubuntu 24.04.
   - **Shape:** Ampere **VM.Standard.A1.Flex**, 2 OCPU, 12 GB RAM. It's marked "Always Free-eligible".
   - **SSH keys:** "Generate a key pair for me", and **download the private key**.
3. If you see "Out of capacity", try another availability domain or try again later.
4. Note the instance's **public IP**.

## 2. Install the robot

From Windows PowerShell, connect with the downloaded key:

```bash
ssh -i C:\Users\YOU\Downloads\ssh-key.key ubuntu@PUBLIC_IP
```

On the machine:

```bash
git clone https://github.com/harshavardhangowda525-spec/ai-sales-automation-.git && cd ai-sales-automation-/ugc-robot && bash setup.sh
```

## 3. Connect it to the backend

1. Put the same `UGC_ROBOT_TOKEN` in `ugc-robot/.env` (`nano .env`) and on Render.
2. On Render, set `REELS_ENGINE=ugc_robot`. From then on the coded reels stop.

## 4. Sign in to Google once (remote screen)

1. Open a tunnel from your laptop:

   ```bash
   ssh -i C:\Users\YOU\Downloads\ssh-key.key -L 6080:127.0.0.1:6080 ubuntu@PUBLIC_IP
   ```

2. Open **http://localhost:6080/vnc.html** in your browser and click **Connect**. You'll see the robot's Chrome.
3. Sign in to **gemini.google.com** with the Google account that has your subscription.
4. Open **labs.google/fx/tools/flow** once and accept any terms.

## 5. Check it, then start it

Check the sign-in and save screenshots of both pages to `~/ugc-work/probe`:

```bash
npm run probe
```

Start the robot:

```bash
sudo systemctl enable --now ugc-robot
```

Follow its log:

```bash
journalctl -u ugc-robot -f
```

The dashboard API `GET /api/reels/robot` shows whether the robot is online.

## When something breaks

| Symptom | Fix |
|---|---|
| Jarvis says "the Gemini robot is offline" | `sudo systemctl restart ugc-chrome ugc-robot` |
| "signed out" | Repeat step 4 |
| "prompt box not found" / "toggle not found" | Google changed the page. Run `npm run probe`, then update `src/selectors.json` |
| "did not return a video" | Flow credits used up, or Flow is slow. Check Flow in the remote screen |
| Error screenshots | `~/ugc-work/<date>/` |

**Status:** the Gemini and Flow page steps are **not tested yet**, because they need your signed-in
browser. The first run will most likely need a selector fix from the probe screenshots. Joining the
clips and the backend side (job, upload, approval call, posting) are tested.
