export const summaryFeedback = "Name what I can collect and how it helps me find an idea later.";
export const actionFeedback = 'Make the action specific: "Start a collection".';
export const overallNote = "Keep the calm tone. Make the benefit and next step concrete.";

export function fieldNotes({ edited = false, revised = false } = {}) {
  return `<!doctype html><html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Field Notes - landing page</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; color: #26352d; background: #fcfaf6; font: 17px/1.6 system-ui, sans-serif; }
    main { max-width: 960px; margin: auto; padding: 30px 40px 60px; }
    header { display: flex; align-items: center; justify-content: space-between; padding-bottom: 24px; border-bottom: 1px solid #deded4; }
    .brand { font-weight: 750; letter-spacing: -.5px; font-size: 22px; }
    .edition { color: #69756d; font-size: 12px; letter-spacing: 1.4px; text-transform: uppercase; }
    .hero { padding: 40px 0 38px; }
    .eyebrow { color: #5a7161; font-size: 12px; font-weight: 650; letter-spacing: 1.6px; text-transform: uppercase; }
    h1 { max-width: 560px; margin: 14px 0 20px; font-size: 46px; line-height: 1.12; letter-spacing: -1.8px; font-weight: 650; }
    #summary { max-width: 420px; margin: 0 0 24px; color: #4e5d53; font-size: 19px; line-height: 1.65; }
    #action { display: inline-block; padding: 10px 20px; border-radius: 8px; background: #345543; color: white; text-decoration: none; font-size: 14px; font-weight: 600; }
    .small { color: #69756d; font-size: 12px; }
    .collections { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; padding-top: 26px; border-top: 1px solid #deded4; }
    .collection { padding: 18px; background: #f1f0e8; border-radius: 10px; }
    .number { color: #69756d; font-size: 11px; letter-spacing: 1px; }
    h2 { margin: 8px 0; font-size: 17px; font-weight: 650; }
    .collection p { margin: 0; font-size: 13px; color: #59665e; }
    @media(max-width: 650px) { main { padding: 24px; } h1 { font-size: 38px; } .collections { grid-template-columns: 1fr; } }
  </style>
</head><body><main>
  <header><span class="brand">Field Notes</span> <span class="edition">A space for your ideas</span></header>
  <section class="hero">
    <p class="eyebrow">A little room to think</p>
    <h1 id="headline">${edited ? "Your next good idea starts here." : "Your next idea starts here."}</h1>
    <p id="summary">${revised
      ? "Keep your notes and links in small, focused collections. Find the thread when you are ready."
      : "A better way to keep everything together, so you can focus on what matters."}</p>
    <a id="action" href="#collections">${revised ? "Start a collection" : "Learn more"}</a>
    <p class="small">Start small. Leave room for the unexpected.</p>
  </section>
  <section id="collections" class="collections" aria-label="Ways to use Field Notes">
    <article class="collection"><span class="number">01 / COLLECT</span><h2>Catch the thought</h2><p>A note, a link, a line you want to remember.</p></article>
    <article class="collection"><span class="number">02 / CONNECT</span><h2>Follow a thread</h2><p>Bring related ideas together, at your own pace.</p></article>
    <article class="collection"><span class="number">03 / RETURN</span><h2>Make room for more</h2><p>Pick up where you left off and see what grows.</p></article>
  </section>
</main></body></html>`;
}
