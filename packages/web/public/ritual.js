// 展卷（rite）纯逻辑：结局大典的数据装配与降级。
// 档案馆点击「走过的结局」展开全文——前因后果要说清楚：
// 正史压卷 / 案语 / 落幕行 / 后日谈 / 双轨史册都来自 run_memory.storyline.codex
// （内核 events.js 结局屏自足数据，与落幕同源）。老局没有 codex 也体面：
// 题名、正史一行、人与事、回忆录照展，不硬凑幕。
// 未解锁的内容在装配层就缺席——封存卡（未开封/未开启）无任何可泄露字段。
// 测试见 test/unit/ritual.test.js。

/** 走过的结局 → 大典各幕。run 为 null（没走过）返回 null——没有大典，只有封存。 */
export function endingRiteSections(run, gallery) {
  if (!run || !gallery) return null;
  const story = run.storyline || {};
  const codex = story.codex || {};
  const tracks = codex.tracks || {};
  const annals = codex.annals || [];
  const notes = codex.notes || [];
  return {
    title: gallery.title,
    canon: gallery.canon,
    day: run.day ?? null,
    survivors: run.survivors || [],
    fallen: run.fallen || [],
    threeThings: run.threeThings || [],
    memoir: run.memoir || '',
    annals,
    notes,
    lines: codex.lines || [],
    futures: codex.futures || [],
    tracks: { city: tracks.city || [], gen: tracks.gen || [] },
    // 有没有「故事幕」：老局没有 codex，只有题名与账——仪式照开，不硬凑
    hasStory: !!(annals.length || notes.length || (codex.futures || []).length)
  };
}
