import { api } from './api.js';
export const account = { user:null,ready:false };
export async function refreshAccount() {
  try {
    const session=await api('/auth/get-session');
    account.user=session?.user?.emailVerified ? session.user : null;
  } finally { account.ready=true; }
  return account.user;
}
