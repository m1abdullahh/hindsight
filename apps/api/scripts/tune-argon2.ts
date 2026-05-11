// Argon2id parameter tuning helper.
//
// Run on the target hardware (laptop dev box, the serverless host's runtime,
// CI runner) to find memory/time costs that hash a password in roughly the
// target window. The defaults baked into apps/api/src/auth/password.ts target
// ~250ms on a modern x86_64 server. Re-run periodically (e.g. when the deploy
// host's instance class changes) and update the constants in password.ts if
// the numbers drift.
//
// Usage:
//   pnpm --filter @hindsight/api tune:argon2
//   pnpm --filter @hindsight/api tune:argon2 -- --target 300 --memory 96 192 256 --time 2 3 4

import argon2 from 'argon2';

interface Options {
  targetMs: number;
  memoryCostsMib: number[];
  timeCosts: number[];
  parallelism: number;
  samples: number;
  password: string;
}

const DEFAULTS: Options = {
  targetMs: 250,
  memoryCostsMib: [32, 64, 96, 128],
  timeCosts: [2, 3, 4, 5],
  parallelism: 1,
  samples: 5,
  password: 'tune-argon2-benchmark-password',
};

const collectListArg = (argv: string[], start: number): { values: number[]; consumed: number } => {
  const values: number[] = [];
  let i = start;
  while (i < argv.length) {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) break;
    values.push(Number(v));
    i++;
  }
  return { values, consumed: i - start };
};

const parseArgs = (argv: string[]): Options => {
  const o: Options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--target' && next !== undefined) {
      o.targetMs = Number(next);
      i++;
    } else if (flag === '--memory') {
      const { values, consumed } = collectListArg(argv, i + 1);
      if (values.length > 0) o.memoryCostsMib = values;
      i += consumed;
    } else if (flag === '--time') {
      const { values, consumed } = collectListArg(argv, i + 1);
      if (values.length > 0) o.timeCosts = values;
      i += consumed;
    } else if (flag === '--parallelism' && next !== undefined) {
      o.parallelism = Number(next);
      i++;
    } else if (flag === '--samples' && next !== undefined) {
      o.samples = Number(next);
      i++;
    }
  }
  return o;
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return Number.NaN;
  const mid = Math.floor(s.length / 2);
  const a = s[mid - 1] ?? 0;
  const b = s[mid] ?? 0;
  return s.length % 2 === 0 ? (a + b) / 2 : b;
};

interface Row {
  memoryCostMib: number;
  timeCost: number;
  parallelism: number;
  medianMs: number;
}

const measure = async (
  password: string,
  memoryCostMib: number,
  timeCost: number,
  parallelism: number,
  samples: number,
): Promise<number> => {
  // Warm-up
  await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: memoryCostMib * 1024,
    timeCost,
    parallelism,
  });

  const observed: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = process.hrtime.bigint();
    await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: memoryCostMib * 1024,
      timeCost,
      parallelism,
    });
    const end = process.hrtime.bigint();
    observed.push(Number(end - start) / 1_000_000);
  }
  return median(observed);
};

const main = async (): Promise<void> => {
  const opts = parseArgs(process.argv.slice(2));
  console.log('Argon2id tuning');
  console.log('---------------');
  console.log(`Target: ${opts.targetMs} ms`);
  console.log(`Parallelism: ${opts.parallelism}`);
  console.log(`Samples per cell: ${opts.samples}`);
  console.log('');

  const rows: Row[] = [];
  for (const m of opts.memoryCostsMib) {
    for (const t of opts.timeCosts) {
      const ms = await measure(opts.password, m, t, opts.parallelism, opts.samples);
      rows.push({ memoryCostMib: m, timeCost: t, parallelism: opts.parallelism, medianMs: ms });
      console.log(
        `m=${String(m).padStart(4)} MiB  t=${t}  p=${opts.parallelism}  ${ms.toFixed(1).padStart(7)} ms`,
      );
    }
  }

  console.log('');
  const window = [opts.targetMs * 0.85, opts.targetMs * 1.25] as const;
  const inWindow = rows.filter((r) => r.medianMs >= window[0] && r.medianMs <= window[1]);
  if (inWindow.length === 0) {
    console.log(`No combination landed in [${window[0]}–${window[1]}] ms. Widen the grid.`);
    return;
  }

  // Prefer the highest memory cost in window; ties break to lowest time cost.
  inWindow.sort((a, b) => b.memoryCostMib - a.memoryCostMib || a.timeCost - b.timeCost);
  const best = inWindow[0];
  if (!best) {
    console.log('No combination matched after filtering. Widen the grid.');
    return;
  }
  console.log('Recommended:');
  console.log(
    `  memoryCost: ${best.memoryCostMib} * 1024,  timeCost: ${best.timeCost},  parallelism: ${best.parallelism}`,
  );
  console.log(`  median: ${best.medianMs.toFixed(1)} ms`);
  console.log('');
  console.log('Update apps/api/src/auth/password.ts PARAMS to match if these differ.');
};

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
