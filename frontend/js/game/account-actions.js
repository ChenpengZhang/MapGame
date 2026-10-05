import { api } from '../core/api.js';
import { account,refreshAccount } from '../core/account.js';
import { $,hide,show,setText } from '../core/dom.js';
import { showMenu } from './session.js';
import { clearGuestTowerState,loadStoryProgress,loadTowerState } from './progress.js';
import { cityById } from '../data/cities.js';

let mode='login';
let busy=false;
let pendingEmail='';
const MODE_UI={
  login:{title:'登录',submit:'登录',email:true,password:true,loginLinks:true},
  register:{title:'注册',submit:'注册',name:true,email:true,password:true,registerConfirm:true},
  'register-otp':{title:'验证邮箱',submit:'确认',otp:true,otpLinks:true},
  forgot:{title:'找回密码',submit:'发送验证码',email:true},
  'forgot-otp':{title:'输入验证码',submit:'下一步',otp:true,otpLinks:true},
  'reset-password':{title:'设置新密码',submit:'确认',newPassword:true},
};

function renderAccount() {
  setText('account-button',account.user?.name || '登录 / 注册');
  hide('account-menu');
  if(account.user)hide('tower-guest-notice');
}
export async function initializeAccount() {
  // Browser-only startup; gameplay unit tests have no location.
  if(typeof location === 'undefined') return;
  const url=new URL(location.href);
  const verified=url.searchParams.has('verified');
  const verificationError=url.searchParams.get('error');
  try {
    await refreshAccount();
    if(account.user) {
      showMenu();
      await Promise.all([loadStoryProgress(), loadTowerState()]);
    }
  } catch { /* The login dialog must still open after an email callback. */ }
  renderAccount();
  if(verified || verificationError) {
    openAccount('login');
    setText('account-message',verificationError ? '验证链接无效或已过期，请重新注册。':'邮箱验证完成，请登录。');
    history.replaceState(null,'',location.pathname);
  }
}
function setAccountMode(nextMode,message='') {
  mode=nextMode;
  const ui=MODE_UI[mode] || MODE_UI.login;
  setText('account-title',ui.title);
  setText('account-submit',ui.submit);
  for(const [id,visible] of [
    ['account-name-field',ui.name],['account-email-field',ui.email],
    ['account-password-field',ui.password],['account-register-confirm-field',ui.registerConfirm],
    ['account-otp-field',ui.otp],
    ['account-new-password-field',ui.newPassword],['account-login-links',ui.loginLinks],
    ['account-otp-links',ui.otpLinks],
  ]) (visible?show:hide)(id);
  $('account-nickname').required=!!ui.name;
  $('account-email').required=!!ui.email;
  $('account-password').required=!!ui.password;
  $('account-password').autocomplete=mode==='register'?'new-password':'current-password';
  $('account-register-confirm').required=!!ui.registerConfirm;
  $('account-otp').required=!!ui.otp;
  $('account-new-password').required=!!ui.newPassword;
  $('account-confirm-password').required=!!ui.newPassword;
  setText('account-message',message);
  const focusId=ui.otp?'account-otp':ui.newPassword?'account-new-password':ui.name?'account-nickname':'account-email';
  $(focusId)?.focus();
}

function setAccountBusy(value) {
  busy=value;
  $('account-submit').disabled=value;
  $('account-resend').disabled=value;
}

export function openAccount(nextMode='login') {
  closeAccountMenu();
  document.body?.classList.add('modal-open');
  pendingEmail='';
  $('account-password').value='';
  $('account-register-confirm').value='';
  $('account-otp').value='';
  $('account-new-password').value='';
  $('account-confirm-password').value='';
  show('account-dialog');
  setAccountMode(nextMode);
}
export function closeAccount() {
  if(busy)return;
  hide('account-dialog');
  document.body?.classList.remove('modal-open');
  pendingEmail='';
  $('account-password').value='';
  $('account-register-confirm').value='';
  $('account-otp').value='';
  $('account-new-password').value='';
  $('account-confirm-password').value='';
}
export function closeAccountMenu() { hide('account-menu'); }
export function toggleAccountMenu() {
  if(!account.user) { openAccount('login');return; }
  $('account-menu')?.classList.toggle('hidden');
}
export async function submitAccount(event) {
  event.preventDefault();if(busy)return;
  setAccountBusy(true);setText('account-message','正在处理…');
  const email=$('account-email').value.trim();
  try {
    if(mode==='register') {
      const password=$('account-password').value;
      if(password!==$('account-register-confirm').value) throw new Error('两次密码不一致。');
      await api('/auth/sign-up/email',{email,password,name:$('account-nickname').value.trim()});
      pendingEmail=email;
      $('account-password').value='';
      $('account-register-confirm').value='';
      $('account-otp').value='';
      setAccountMode('register-otp',`验证码已发送至 ${email}`);
    } else if(mode==='register-otp') {
      await api('/auth/email-otp/verify-email',{email:pendingEmail,otp:$('account-otp').value});
      $('account-email').value=pendingEmail;
      $('account-otp').value='';
      setAccountMode('login','注册成功，请登录。');
    } else if(mode==='forgot') {
      await api('/auth/email-otp/request-password-reset',{email});
      pendingEmail=email;
      $('account-otp').value='';
      setAccountMode('forgot-otp','如果邮箱已注册，验证码已发送。');
    } else if(mode==='forgot-otp') {
      await api('/auth/email-otp/check-verification-otp',{email:pendingEmail,type:'forget-password',otp:$('account-otp').value});
      setAccountMode('reset-password');
    } else if(mode==='reset-password') {
      const password=$('account-new-password').value;
      if(password!==$('account-confirm-password').value) throw new Error('两次密码不一致。');
      await api('/auth/email-otp/reset-password',{email:pendingEmail,otp:$('account-otp').value,password});
      $('account-email').value=pendingEmail;
      $('account-otp').value='';
      $('account-new-password').value='';
      $('account-confirm-password').value='';
      setAccountMode('login','密码已重置，请登录。');
    } else {
      await api('/auth/sign-in/email',{email,password:$('account-password').value});
      clearGuestTowerState();
      location.assign('/mapgame/'); // Fresh state prevents importing guest data or another account's state.
    }
  } catch(error) {
    if(mode==='login' && error.code==='EMAIL_NOT_VERIFIED') {
      pendingEmail=email;
      $('account-password').value='';
      $('account-otp').value='';
      setAccountMode('register-otp',`验证码已发送至 ${email}`);
    } else setText('account-message',error.message);
  } finally { setAccountBusy(false); }
}

export async function resendAccountCode() {
  if(busy || !pendingEmail || !['register-otp','forgot-otp'].includes(mode))return;
  setAccountBusy(true);setText('account-message','正在发送…');
  try {
    if(mode==='register-otp') await api('/auth/email-otp/send-verification-otp',{email:pendingEmail,type:'email-verification'});
    else await api('/auth/email-otp/request-password-reset',{email:pendingEmail});
    setText('account-message','验证码已重新发送。');
  } catch(error) { setText('account-message',error.message); }
  finally { setAccountBusy(false); }
}
export async function logout() {
  if(busy)return;busy=true;
  closeAccountMenu();
  try{await api('/auth/sign-out',{});location.assign('/mapgame/');}
  catch(error){openAccount('login');setText('account-message',error.message);}finally{busy=false;}
}
// 游玩记录分页：每页条数由服务端决定（见 backend game-service.js HISTORY_PAGE），点「加载更多」接着取下一页
const HISTORY_MODES={tower:'无尽模式',free:'随机模式',story:'故事模式',daily:'每日挑战',custom:'自定义模式'};
let historyVersion=0;

function historyRow(row) {
  const element=document.createElement('div');element.className='history-row';
  const city=cityById(row.city_id)?.name||row.city_id;
  element.textContent=`${city} · ${HISTORY_MODES[row.mode]||row.mode}${row.mode==='tower'?` · 第 ${row.stage_no} 层`:''}\n路线 ${(Number(row.duration_ms)/60000).toFixed(1)} 分钟 · ${row.passed?'完成':'未通过'}\n${new Date(row.submitted_at).toLocaleString('zh-CN')}`;
  element.style.whiteSpace='pre-line';
  return element;
}

/** 把一页记录追加到列表；还有下一页时在末尾放「加载更多」 */
function appendHistoryPage(list,page,version) {
  list.querySelector('.history-more')?.remove();
  for(const row of page.rows||[])list.appendChild(historyRow(row));
  if(!page.next)return;
  const more=document.createElement('button');more.type='button';more.className='history-more';more.textContent='加载更多';
  more.addEventListener('click',async()=>{
    more.disabled=true;more.textContent='正在加载…';
    try{
      const next=await api(`/history?${new URLSearchParams({cursor:page.next})}`);
      if(version===historyVersion)appendHistoryPage(list,next,version);
    }catch(error){more.disabled=false;more.textContent=`加载失败（${error.message}），点此重试`;}
  });
  list.appendChild(more);
}

export async function showHistory() {
  closeAccountMenu();
  document.body?.classList.add('modal-open');
  show('history-dialog');setText('history-list','正在加载…');
  const version=++historyVersion;
  try {
    const first=await api('/history');
    if(version!==historyVersion)return;
    const list=$('history-list');list.replaceChildren();
    if(!first.rows?.length) { list.textContent='还没有已保存的游玩记录，完成一局后会显示在这里。';return; }
    appendHistoryPage(list,first,version);
  }catch(error){if(version===historyVersion)setText('history-list',error.message);}
}
export function closeHistory() {
  hide('history-dialog');
  document.body?.classList.remove('modal-open');
}
