// 意图拒绝码 → 人话（一周目实测教训：书页上摔出「NO_ITEM」级别的裸码，
// 出戏且不解释原因）。内核只发明码，翻译集中在这里——server 书页行与 UI 共用。
// 静态测试守门：core/src 里新出现的 reason 码若不在表里，测试红。

export const REJECT_TEXT = {
  BAD_ACTION: '没有这个动作',
  BAD_OPTION: '没有这个选项',
  BAD_PHASE: '现在不是做这件事的时候',
  BAD_POLICY: '没有这条规矩',
  BAD_SHAPE: '这个要求说不成形',
  BAD_TARGET: '目标不对',
  BAD_TYPE: '做不了这件事',
  DEPRESSED: '有人情绪太低，不肯动',
  DONE_TODAY: '今天已经做过了',
  EMPTY: '话得说完整',
  FULL: '已经吃饱了，再吃就是浪费',
  HOME_NIGHT: '今晚在家里，不出门',
  IN_PROLOGUE: '序章还没读完',
  MAX: '已经到头了，再加不动',
  NEED_FACILITY: '得先有那件家什',
  NEED_REPAIR: '东西得先修',
  NEED_TRAIT: '没有人会干这个',
  NOTHING: '没有可翻的了',
  NOT_DAY: '得等到白天',
  NOT_DUSK: '得等到黄昏',
  NOT_NIGHT: '得等到夜里',
  NO_AP: '人已经乏了，今天动不了',
  NO_CARD: '眼前没有这张卡',
  NO_CHAR: '没有这个人',
  NO_EVENT: '眼前没有待决的事',
  NO_ITEM: '手头没有那个东西',
  NO_MERCHANT: '商人不在门口',
  NO_NEED: '还用不上',
  NO_PATIENT: '没有要治的人',
  NO_STOCK: '摊上没有这个货',
  NO_TARGET: '没有这个对象',
  PRICE_BAND: '价开得太离谱',
  TOO_WEAK: '人已经迈不动夜路了',
  UNAVAILABLE: '条件还不够',
  UNKNOWN_LOC: '还不知道那个地方',
  USE_COOK: '这个要在锅上做'
};

/** 拒绝码 → 人话；未知码原样返回（新码漏登记时不至于崩，静态测试会抓） */
export function rejectText(reason) {
  return REJECT_TEXT[reason] || String(reason);
}
