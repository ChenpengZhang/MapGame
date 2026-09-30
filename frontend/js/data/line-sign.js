/**
 * data/line-sign.js —— 线路名称牌的文字排版（纯函数，无 DOM 依赖）
 *
 * 站点信息卡（map/hover.js）与路线规划面板（ui/route-panel.js）共用同一套线路牌：
 *   公交：线路号放大为主体，“路”、名称前缀与方向说明缩小跟排；
 *   地铁：大号线路数字在左，“号线 / Line N”在右侧上下排列；
 *   没有数字的线路：整名缩小居中。
 * 样式见 index.html 的 .line-tag / .bus-line / .metro-line 规则。
 */

export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 公交牌以线路号为主体；名称前缀、“路”及方向说明都缩为同一级。 */
function splitBusLineName(name) {
  const value = String(name || '').trim();
  const numbered = value.match(/^(.*?)([A-Za-zＡ-Ｚａ-ｚ]?[0-9０-９]+[A-Za-zＡ-Ｚａ-ｚ]?)(.*)$/);
  if (numbered) {
    return { prefix: numbered[1], main: numbered[2], suffix: numbered[3] };
  }
  return { prefix: '', main: value, suffix: '' };
}

/** 地铁线路牌：大号线路数字在左，“号线 / Line N”在右侧上下排列。 */
function metroLineName(name) {
  // 名称牌只保留线路号：去掉“地铁 / 轨道交通”前缀（重庆、武汉的地铁叫“轨道交通N号线”）
  const chinese = String(name || '').trim().replace(/^(地铁|轨道交通)/, '');
  const numbered = chinese.match(/^([A-Za-zＡ-Ｚａ-ｚ]?[0-9０-９]+)(.*)$/);
  if (numbered) {
    return { main: numbered[1], suffix: numbered[2], english: `Line ${numbered[1]}` };
  }
  // 邻市地铁带城市前缀（如“绍兴1号线”）：数字仍作主体，城市名放在右下小字位置
  const prefixed = chinese.match(/^([^0-9０-９]{1,4}?)([A-Za-z]?[0-9０-９]+)(号线.*)$/);
  if (prefixed) {
    return { main: prefixed[2], suffix: prefixed[3], english: prefixed[1] };
  }
  const named = chinese.match(/^(.+?)(线.*)$/);
  return {
    main: named ? named[1] : chinese,
    suffix: named ? named[2] : '',
    english: 'Metro Line',
  };
}

/**
 * 唯一判定规则：有数字就突出数字并缩小前后缀；没有数字才整体缩小居中。
 */
function isTextLine(line) {
  const value = String(line.name || '').trim();
  return !/[0-9０-９]/.test(value);
}


/** 线路牌的 class（颜色由调用方按线路色设置背景） */
export function lineSignClass(line) {
  return 'line-tag ' + (line.mode === 'metro' ? 'metro-line' : 'bus-line') + (isTextLine(line) ? ' text-line' : '');
}

/** 线路牌内部 HTML（已转义） */
export function lineSignInnerHTML(line) {
  if (isTextLine(line)) {
    return `<span class="line-main">${escapeHtml(String(line.name).replace(/^(地铁|轨道交通)/, ''))}</span>`;
  }
  if (line.mode === 'metro') {
    const label = metroLineName(line.name);
    return `<span class="metro-line-main">${escapeHtml(label.main)}</span>`
      + '<span class="metro-line-side">'
      + `<span class="metro-line-suffix">${escapeHtml(label.suffix)}</span>`
      + `<span class="metro-line-en">${escapeHtml(label.english)}</span>`
      + '</span>';
  }
  const parts = splitBusLineName(line.name);
  return '<span class="bus-line-content">'
    + (parts.prefix ? `<span class="line-prefix">${escapeHtml(parts.prefix)}</span>` : '')
    + `<span class="line-main">${escapeHtml(parts.main)}</span>`
    + (parts.suffix ? `<span class="line-suffix">${escapeHtml(parts.suffix)}</span>` : '')
    + '</span>';
}
