// 兜底推进卡（补笔）的纯逻辑：任何「无卡可点」的存档都要有路走。
// 背景：断线或旧档可能停在没有任何停问卡的状态（渲染链半途被砸断，
// 或落在从不停留的相位）——玩家面对一本翻不动的书。按相位给出安全的
// 推进选项；意图形状必须落在内核 validateIntentShape 认得的集合里。
// 测试见 test/unit/rescue.test.js。

/** @returns {{label:string, intents?:Array, input?:string, hint?:string}[]} */
export function rescueOptions(s) {
  const byPhase = {
    // 序章卡没落出来：翻页/跳过都是既有合法步
    prologue: [
      { label: '翻过序章，直接进城', intents: [{ type: 'skip_prelude' }] },
      { label: '翻页', intents: [{ type: 'advance' }] }
    ],
    // 白天：交给管家收卷，或直接入黄昏——两条都是日常宏
    day: [
      { label: '把这一天交给他们（照常过）', intents: [{ type: 'auto_day' }], hint: '管家张罗，方略一次走完这一天' },
      { label: '今天到此为止，入黄昏', intents: [{ type: 'advance' }] }
    ],
    // 黄昏方案卡没落出来：没有普适按钮，用原话走输入管线（自由文本是万能钥匙）
    dusk: [
      { label: '今晚谁都不出去，守在家里', input: '今晚都不出去，守在家里' }
    ],
    // 夜访卡没落出来：收工或继续都是夜访既有步
    night: [
      { label: '今晚到此为止（收工回家）', intents: [{ type: 'night', action: 'retreat' }] },
      { label: '继续摸黑前进', intents: [{ type: 'auto_night' }] }
    ],
    // 平旦是从不停留的相位：任何输入都会把这一页翻过去（内核见 dawn 即推到 day）
    dawn: [
      { label: '天亮了——把这一页翻过去', intents: [{ type: 'advance' }] }
    ]
  };
  return byPhase[s?.phase] || [{ label: '把日子往下过（照常）', intents: [{ type: 'auto_day' }] }];
}

/** 补笔卡的题头（相位 → 人话） */
export const RESCUE_TITLE = {
  prologue: '把序章翻过去',
  day: '把这一天往下过',
  dusk: '把这一夜定下来',
  night: '把这一夜走完',
  dawn: '天亮了'
};
