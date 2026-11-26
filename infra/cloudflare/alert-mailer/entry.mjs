import { EmailMessage } from 'cloudflare:email';
import { createMailer } from './worker.mjs';

const mailer = createMailer();
export default {
  fetch(request, env) {
    return mailer.fetch(request, { ...env, EmailMessage });
  },
};
