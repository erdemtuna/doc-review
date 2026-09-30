import { REVIEW_PALETTE } from "../src/review-palette.js";

export function readmeCover(image) {
  const palette = REVIEW_PALETTE.light;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <title>Doc Review social cover</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; width: 1280px; height: 640px; overflow: hidden; background: ${palette.background}; color: ${palette.foreground}; font-family: system-ui, sans-serif; }
    main { padding: 52px 54px; }
    .eyebrow { margin: 0 0 24px; color: ${palette["muted-foreground"]}; font-size: 15px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; }
    h1 { margin: 0 0 24px; font-size: 66px; letter-spacing: -3px; line-height: 1; }
    .message { max-width: 365px; font-size: 29px; line-height: 1.35; letter-spacing: -.5px; }
    .steps { margin-top: 36px; font-size: 16px; font-weight: 600; color: ${palette.primary}; }
    .url { position: absolute; bottom: 42px; left: 54px; font-size: 15px; color: ${palette["muted-foreground"]}; }
    .preview { position: absolute; left: 455px; top: 48px; width: 780px; border: 1px solid ${palette.border}; border-radius: 16px; overflow: hidden; background: ${palette.card}; box-shadow: 0 20px 60px ${palette["review-shadow-color"]}; }
    .preview img { display: block; width: 100%; height: auto; }
  </style></head><body><main>
    <p class="eyebrow">Feedback beside the document</p>
    <h1>Doc Review</h1>
    <p class="message">Review and refine documents with your agent.</p>
    <p class="steps">Ask questions. Request changes.</p>
    <p class="url">github.com/erdemtuna/doc-review</p>
    <div class="preview"><img src="data:image/png;base64,${image}" alt="Doc Review with an anchored comment"></div>
  </main></body></html>`;
}
