# Daily UGC ad: the 5 PM Claude task on your laptop

Every day at 5 PM the server prepares the day's ad job. A scheduled Claude task on your laptop:
1. writes the script;
2. makes 3 vertical clips in **Google Flow** (your Gemini subscription) in your own Chrome;
3. uploads the clips.

The server then joins them into one ~36-second reel, Jarvis calls you for approval, and once you
approve it posts at 7:30 PM. If the laptop is off, Jarvis calls you at about 5:20 PM to say the ad
wasn't made.

## One-time setup

1. Install the **Claude desktop app** and the **Claude in Chrome** extension.
2. In Chrome, sign in to **labs.google/fx/tools/flow** with your Gemini account and make one test clip
   by hand. This accepts Flow's terms and shows where the download goes.
3. In the Claude desktop app, create a **scheduled task**:
   - **Schedule:** daily at **5:03 PM**.
   - **Prompt:** the text below, with `TOKEN` replaced by the robot token.
   - Give it access to your **Downloads** folder and to Chrome.
4. Run the task once by hand to check it.

## Task prompt (paste into the scheduled task)

```text
You are making today's Instagram UGC ad for Infinity Web & Apps. Work autonomously; do not ask me questions.
API = https://infinity-automation-api.onrender.com   TOKEN = TOKEN
Use curl.exe for every API call, with the header "Authorization: Bearer TOKEN".

1. Get today's job: POST {API}/ugc-robot/next . If "job" is null, check again every 2 minutes for up to
   10 minutes (the server may be waking up). If there is still no job, stop.
2. Read job.writer_prompt and follow it yourself. Write the 3 scenes (line + video_prompt) and the caption.
   Then send the script: POST {API}/ugc-robot/script?reel_id={job.reel_id}
   with JSON body {"topic": "...", "caption": "..."}.
3. In Chrome, open https://labs.google/fx/tools/flow and start a new project. For each scene 1..3:
   - set the aspect ratio to 9:16 (portrait) and the duration to the longest available (about 10-12 s);
   - paste the scene's video_prompt, make sure the exact spoken line is in it, and generate one video;
   - wait until it is finished (this can take several minutes), watch it once, and regenerate once if
     the person, the speech or the text in the video is clearly broken;
   - download it (MP4), then upload it:
     curl.exe -X POST -H "Authorization: Bearer TOKEN" -H "Content-Type: video/mp4"
       --data-binary "@<path to the downloaded mp4>" "{job.clip_url}<n>"
     (n = 1, 2, 3). The reply lists the clips received so far.
4. After clip 3 the reply says "done": true. The server joins the clips and Jarvis calls me. You are finished.
5. Until 7:15 PM, check POST {API}/ugc-robot/next every 5 minutes. If a new job appears, I asked for
   changes on the approval call: redo it from step 2 (job.writer_prompt contains my changes).
If Flow is signed out, out of credits or broken, stop and say why in one sentence. The server will
tell me on the phone.
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Jarvis: "the Claude task on your laptop did not start" | Laptop was off or asleep, or Claude wasn't open. Ask Jarvis to "make today's reel again" after opening it |
| A reply says `"error": "This reel is ready"` | It's already done; nothing to fix |
| Clips upload but nothing happens | The caption step (2) was skipped: send the script, and the server finishes on its own |
| Flow out of credits | Check your plan's Flow credits; the ad is skipped that day |
