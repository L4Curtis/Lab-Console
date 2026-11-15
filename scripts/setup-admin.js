/**
 * Create the local administrator's credentials:  npm run setup-admin
 *
 * Asks for a user name and a password (typed without echo, twice), generates
 * a TOTP secret, and prints the three lines to put in .env plus the
 * otpauth:// URI to add to an authenticator app. Nothing is written to disk
 * and the password itself is never printed
 *
 *   npm run setup-admin -- --username curtis
 *   printf '%s\n' "$PASSWORD" | npm run --silent setup-admin -- --username curtis
 *
 * With a pipe on standard input the password is read from its first line
 * (for scripts and secret managers); the user name then comes from
 * --username (default "admin")
 */
import readline from 'node:readline';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '../src/modules/auth/password.js';
import { generateSecret, base32Decode, totp, verifyTotp, otpauthUri } from '../src/modules/auth/totp.js';
import { USERNAME } from '../src/modules/auth/config.js'; // the rule the configuration applies

function option(name) {
  const args = process.argv.slice(2);
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
}

const fail = (message) => {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
};

/** Ask a question on the terminal */
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Ask for a secret: the terminal is put in raw mode so that nothing typed is echoed */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin } = process;
    let value = '';
    const finish = (settle, result) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      settle(result);
    };
    function onData(chunk) {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') return finish(resolve, value);
        if (char === '\u0003') return finish(reject, new Error('Cancelled'));
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
        else if (char >= ' ') value += char;
      }
    }
    process.stderr.write(question);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/** First line of a piped standard input */
async function firstLineOfStdin() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  return '';
}

function checkPassword(password) {
  if (password.length < MIN_PASSWORD_LENGTH) return `The password must be at least ${MIN_PASSWORD_LENGTH} characters long`;
  if (password.length > MAX_PASSWORD_LENGTH) return `The password must be at most ${MAX_PASSWORD_LENGTH} characters long`;
  return null;
}

async function main() {
  const interactive = Boolean(process.stdin.isTTY);
  let username = option('username');
  let password;

  if (interactive) {
    username ??= (await ask('User name [admin]: ')).trim() || 'admin';
    if (!USERNAME.test(username)) fail('The user name must be 1 to 64 letters, digits, dots, dashes or underscores');
    password = await askHidden(`Password (at least ${MIN_PASSWORD_LENGTH} characters, not shown): `);
    const problem = checkPassword(password);
    if (problem) fail(problem);
    if (await askHidden('Same password again: ') !== password) fail('The two passwords are different');
  } else {
    username ??= 'admin';
    if (!USERNAME.test(username)) fail('The user name must be 1 to 64 letters, digits, dots, dashes or underscores');
    password = await firstLineOfStdin();
    const problem = checkPassword(password);
    if (problem) fail(problem);
  }

  const hash = await hashPassword(password);
  const secret = generateSecret();
  // Self-check: what is about to be printed really opens the door
  const key = base32Decode(secret);
  if (!(await verifyPassword(password, hash)) || verifyTotp(key, totp(key)) === null) fail('Internal check failed: nothing was generated');

  const issuer = option('issuer') ?? 'Lab Console';
  const out = [
    '',
    '# Local administrator - add these three lines to .env (they replace any previous ones)',
    `LOCAL_ADMIN_USERNAME=${username}`,
    `LOCAL_ADMIN_PASSWORD_HASH=${hash}`,
    `LOCAL_ADMIN_TOTP_SECRET=${secret}`,
    '',
    '# Add this account to an authenticator app (Aegis, 2FAS, Google Authenticator, a password',
    '# manager…): scan it as a QR code, or type the secret above by hand (time-based, SHA-1, 6 digits, 30 s)',
    otpauthUri({ secret, account: username, issuer }),
    '',
    '# The secret and the URI are as sensitive as the password: keep .env readable by the service only',
    '',
  ];
  process.stdout.write(`${out.join('\n')}`);
}

main().catch((err) => fail(err.message));
