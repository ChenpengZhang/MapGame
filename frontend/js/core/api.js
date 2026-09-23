const messages = {
  LOGIN_REQUIRED:'登录已失效，请重新登录后重试。',
  INVALID_EMAIL_OR_PASSWORD:'邮箱或密码不正确。', EMAIL_NOT_VERIFIED:'请先验证邮箱，再登录。',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:'该邮箱已注册，请登录或重置密码。',
  INVALID_OTP:'验证码不正确。', OTP_EXPIRED:'验证码已过期，请重新发送。',
  TOO_MANY_ATTEMPTS:'尝试次数过多，请重新发送验证码。',
  PASSWORD_TOO_SHORT:'密码至少需要 12 位。', PASSWORD_TOO_LONG:'密码过长。',
  INVALID_TOKEN:'链接已失效，请重新申请。', TOKEN_EXPIRED:'链接已过期，请重新申请。',
  INVALID_INPUT:'提交内容不符合要求，请刷新后重试。',
  UNTRUSTED_ORIGIN:'网站地址与服务器配置不一致，请联系维护者。',
  PUZZLE_VERSION_UNAVAILABLE:'地图数据已更新，请刷新页面；旧爬塔需从第一层重开。',
  DAILY_CLOSED:'今天的挑战已结束，请返回菜单重新开始。',
  LINE_NOT_ALLOWED:'路线使用了本局不允许的线路。', INVALID_STOPS:'路线站点无效，尚未入库。',
  DISCONNECTED_ROUTE:'路线不连续，尚未入库。', START_TOO_FAR:'首站距离起点过远。',END_TOO_FAR:'末站距离终点过远。',
  WRONG_DIRECTION_OR_MISSING_EDGE:'路线方向或站间数据无效，尚未入库。',
  STAGE_ALREADY_SETTLED:'本关已结算，请返回菜单恢复进度。',RUN_NOT_ACTIVE:'本局已结束，请重新开始。',
  RUN_NOT_FOUND:'此对局不属于当前账户或已不存在。',
};
export async function api(path,body) {
  let response;
  try {
    response = await fetch('/mapgame/api'+path,{
      method:body === undefined ? 'GET':'POST',credentials:'same-origin',
      headers:body === undefined ? {} : {'Content-Type':'application/json'},
      body:body === undefined ? undefined : JSON.stringify(body),
      signal:AbortSignal.timeout(30000),
    });
  } catch { throw new Error('暂时无法连接服务器。游客仍可游玩；账户记录请保留本页稍后重试。'); }
  let data;
  try { data = response.status === 204 ? null : await response.json(); }
  catch { throw new Error('账户服务暂不可用，仍可使用游客模式。'); }
  if (!response.ok) {
    const code = data?.code || data?.error;
    if(response.status===401 && !path.startsWith('/auth/') && typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('mapgame:session-expired'));
    }
    const error = new Error(response.status === 429 ? '操作过于频繁，请稍后重试。' : messages[code] || '请求未成功，请稍后重试。');
    error.code=code;error.status=response.status;throw error;
  }
  return data;
}
