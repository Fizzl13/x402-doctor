#!/usr/bin/env node
// cis8-sign.mjs (x402 Doctor): sign Concordium CIS-8 canonical bytes with your Algorand or Stellar key, on your own
// computer, to bind your payTo to your Concordium account (https://x402-doctor.fizzl.eu/concordium-payto.html).
//
//   node cis8-sign.mjs <your payTo address> <the bytes hex from the page>
//
// It asks for your secret (Stellar: the S… secret key; Algorand: the 25-word mnemonic) without showing it, derives the
// address from it, stops unless that is the payTo you gave, refuses bytes that are not CIS-8 canonical bytes (so it can't
// be used to sign a transaction), shows what the bytes bind, and prints the signature to paste into the page.
// No network, no dependencies, nothing written to disk: read it before you run it. Node 18 or newer.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createInterface } from 'node:readline';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const fail = (m) => { console.error(`cis8-sign: ${m}`); process.exit(1); };

function base32Bytes(s) {
  let bits = 0, acc = 0;
  const out = [];
  for (const ch of s) {
    const v = BASE32.indexOf(ch);
    if (v < 0) return null;
    acc = ((acc << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
  }
  return Buffer.from(out);
}
function base32String(bytes) {
  let bits = 0, acc = 0, out = '';
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += BASE32[(acc >> bits) & 31]; }
  }
  if (bits) out += BASE32[(acc << (5 - bits)) & 31];
  return out;
}
function crc16xmodem(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
function base58check(payload) {
  const sum = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest().subarray(0, 4);
  const bytes = Buffer.concat([payload, sum]);
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt(`0x${bytes.toString('hex')}`), out = '';
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b) break; out = `1${out}`; }
  return out;
}

const algorandAddress = (key) => base32String(Buffer.concat([key, createHash('sha512-256').update(key).digest().subarray(28, 32)]));
function stellarAddress(key) {
  const body = Buffer.concat([Buffer.from([6 << 3]), key]);
  const crc = crc16xmodem(body);
  return base32String(Buffer.concat([body, Buffer.from([crc & 255, crc >> 8])]));
}

// Algorand's mnemonic: 24 words of 11 bits each, packed little-endian, are the 32-byte seed; the 25th word is a
// checksum (the first 11 bits of the seed's SHA-512/256). The words are BIP-39's English list.
const toUint11 = (bytes) => {
  const out = []; let acc = 0, bits = 0;
  for (const b of bytes) { acc |= b << bits; bits += 8; if (bits >= 11) { out.push(acc & 0x7ff); acc >>= 11; bits -= 11; } }
  if (bits) out.push(acc);
  return out;
};
function algorandSeed(mnemonic) {
  const words = mnemonic.trim().toLowerCase().split(/\s+/);
  if (words.length !== 25) return null;
  const idx = words.map((w) => WORDS.indexOf(w));
  if (idx.some((i) => i < 0)) fail('a word of the mnemonic is not in the word list');
  const out = []; let acc = 0, bits = 0;
  for (const v of idx.slice(0, 24)) { acc |= v << bits; bits += 11; while (bits >= 8) { out.push(acc & 255); acc >>= 8; bits -= 8; } }
  if (bits) out.push(acc);
  if (out.length !== 33 || out[32] !== 0) fail('the mnemonic does not decode to a key');
  const seed = Buffer.from(out.slice(0, 32));
  if (WORDS[toUint11(createHash('sha512-256').update(seed).digest())[0]] !== words[24]) fail('the checksum word does not match (a typo in the mnemonic?)');
  return seed;
}
function stellarSeed(secret) {
  const s = secret.trim();
  if (!/^S[A-Z2-7]{55}$/.test(s)) return null;
  const b = base32Bytes(s);
  if (!b || b.length !== 35 || b[0] !== 18 << 3) fail('not a Stellar secret key');
  if (crc16xmodem(b.subarray(0, 33)) !== (b[33] | (b[34] << 8))) fail('the secret key\'s checksum does not match (a typo?)');
  return Buffer.from(b.subarray(1, 33));
}

// The canonical bytes: "CIS-8/v1/canonical", the Concordium account (32), the contract index and subindex (u64 LE),
// the network's genesis hash (32), then namespace, key namespace, key type, key and proof scheme, each with a u32 LE length.
const GENESIS = { '9dd9ca4d19e9393877d2c44b70f89acbfc0883c2243e5eeaecc0d1cd0503f478': 'mainnet', '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796': 'testnet' };
function readCanonical(bytes) {
  const prefix = Buffer.from('CIS-8/v1/canonical');
  if (bytes.length < 130 || !bytes.subarray(0, prefix.length).equals(prefix)) fail('these are not CIS-8 canonical bytes: nothing signed');
  let at = prefix.length;
  const take = (n) => { if (at + n > bytes.length) fail('the bytes are cut short: nothing signed'); const v = bytes.subarray(at, at + n); at += n; return v; };
  const account = base58check(Buffer.concat([Buffer.from([1]), take(32)]));
  const index = take(8).readBigUInt64LE(), subindex = take(8).readBigUInt64LE();
  const genesis = take(32).toString('hex');
  const str = () => take(take(4).readUInt32LE()).toString('utf8');
  const namespace = str(), keyNamespace = str(), keyType = str();
  const key = Buffer.from(take(take(4).readUInt32LE()));
  const scheme = str();
  if (at !== bytes.length) fail('the bytes carry more than a CIS-8 binding: nothing signed');
  return { account, contract: `<${index},${subindex}>`, network: GENESIS[genesis] || `genesis ${genesis.slice(0, 16)}…`, namespace, keyNamespace, keyType, key, scheme };
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    let muted = false;
    rl._writeToOutput = (s) => { if (!muted) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    muted = true;
  });
}

// BIP-39's English word list (2048 words; SHA-256 of the list, one word a line: 2f5eed53…3b24dbda).
const WORDS = (
  'abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid ' +
  'acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult advance advice ' +
  'aerobic affair afford afraid again age agent agree ahead aim air airport aisle alarm album alcohol alert alien all ' +
  'alley allow almost alone alpha already also alter always amateur amazing among amount amused analyst anchor ancient ' +
  'anger angle angry animal ankle announce annual another answer antenna antique anxiety any apart apology appear apple ' +
  'approve april arch arctic area arena argue arm armed armor army around arrange arrest arrive arrow art artefact ' +
  'artist artwork ask aspect assault asset assist assume asthma athlete atom attack attend attitude attract auction ' +
  'audit august aunt author auto autumn average avocado avoid awake aware away awesome awful awkward axis baby bachelor ' +
  'bacon badge bag balance balcony ball bamboo banana banner bar barely bargain barrel base basic basket battle beach ' +
  'bean beauty because become beef before begin behave behind believe below belt bench benefit best betray better ' +
  'between beyond bicycle bid bike bind biology bird birth bitter black blade blame blanket blast bleak bless blind ' +
  'blood blossom blouse blue blur blush board boat body boil bomb bone bonus book boost border boring borrow boss ' +
  'bottom bounce box boy bracket brain brand brass brave bread breeze brick bridge brief bright bring brisk broccoli ' +
  'broken bronze broom brother brown brush bubble buddy budget buffalo build bulb bulk bullet bundle bunker burden ' +
  'burger burst bus business busy butter buyer buzz cabbage cabin cable cactus cage cake call calm camera camp can ' +
  'canal cancel candy cannon canoe canvas canyon capable capital captain car carbon card cargo carpet carry cart case ' +
  'cash casino castle casual cat catalog catch category cattle caught cause caution cave ceiling celery cement census ' +
  'century cereal certain chair chalk champion change chaos chapter charge chase chat cheap check cheese chef cherry ' +
  'chest chicken chief child chimney choice choose chronic chuckle chunk churn cigar cinnamon circle citizen city civil ' +
  'claim clap clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog close cloth cloud ' +
  'clown club clump cluster clutch coach coast coconut code coffee coil coin collect color column combine come comfort ' +
  'comic common company concert conduct confirm congress connect consider control convince cook cool copper copy coral ' +
  'core corn correct cost cotton couch country couple course cousin cover coyote crack cradle craft cram crane crash ' +
  'crater crawl crazy cream credit creek crew cricket crime crisp critic crop cross crouch crowd crucial cruel cruise ' +
  'crumble crunch crush cry crystal cube culture cup cupboard curious current curtain curve cushion custom cute cycle ' +
  'dad damage damp dance danger daring dash daughter dawn day deal debate debris decade december decide decline ' +
  'decorate decrease deer defense define defy degree delay deliver demand demise denial dentist deny depart depend ' +
  'deposit depth deputy derive describe desert design desk despair destroy detail detect develop device devote diagram ' +
  'dial diamond diary dice diesel diet differ digital dignity dilemma dinner dinosaur direct dirt disagree discover ' +
  'disease dish dismiss disorder display distance divert divide divorce dizzy doctor document dog doll dolphin domain ' +
  'donate donkey donor door dose double dove draft dragon drama drastic draw dream dress drift drill drink drip drive ' +
  'drop drum dry duck dumb dune during dust dutch duty dwarf dynamic eager eagle early earn earth easily east easy echo ' +
  'ecology economy edge edit educate effort egg eight either elbow elder electric elegant element elephant elevator ' +
  'elite else embark embody embrace emerge emotion employ empower empty enable enact end endless endorse enemy energy ' +
  'enforce engage engine enhance enjoy enlist enough enrich enroll ensure enter entire entry envelope episode equal ' +
  'equip era erase erode erosion error erupt escape essay essence estate eternal ethics evidence evil evoke evolve ' +
  'exact example excess exchange excite exclude excuse execute exercise exhaust exhibit exile exist exit exotic expand ' +
  'expect expire explain expose express extend extra eye eyebrow fabric face faculty fade faint faith fall false fame ' +
  'family famous fan fancy fantasy farm fashion fat fatal father fatigue fault favorite feature february federal fee ' +
  'feed feel female fence festival fetch fever few fiber fiction field figure file film filter final find fine finger ' +
  'finish fire firm first fiscal fish fit fitness fix flag flame flash flat flavor flee flight flip float flock floor ' +
  'flower fluid flush fly foam focus fog foil fold follow food foot force forest forget fork fortune forum forward ' +
  'fossil foster found fox fragile frame frequent fresh friend fringe frog front frost frown frozen fruit fuel fun ' +
  'funny furnace fury future gadget gain galaxy gallery game gap garage garbage garden garlic garment gas gasp gate ' +
  'gather gauge gaze general genius genre gentle genuine gesture ghost giant gift giggle ginger giraffe girl give glad ' +
  'glance glare glass glide glimpse globe gloom glory glove glow glue goat goddess gold good goose gorilla gospel ' +
  'gossip govern gown grab grace grain grant grape grass gravity great green grid grief grit grocery group grow grunt ' +
  'guard guess guide guilt guitar gun gym habit hair half hammer hamster hand happy harbor hard harsh harvest hat have ' +
  'hawk hazard head health heart heavy hedgehog height hello helmet help hen hero hidden high hill hint hip hire ' +
  'history hobby hockey hold hole holiday hollow home honey hood hope horn horror horse hospital host hotel hour hover ' +
  'hub huge human humble humor hundred hungry hunt hurdle hurry hurt husband hybrid ice icon idea identify idle ignore ' +
  'ill illegal illness image imitate immense immune impact impose improve impulse inch include income increase index ' +
  'indicate indoor industry infant inflict inform inhale inherit initial inject injury inmate inner innocent input ' +
  'inquiry insane insect inside inspire install intact interest into invest invite involve iron island isolate issue ' +
  'item ivory jacket jaguar jar jazz jealous jeans jelly jewel job join joke journey joy judge juice jump jungle junior ' +
  'junk just kangaroo keen keep ketchup key kick kid kidney kind kingdom kiss kit kitchen kite kitten kiwi knee knife ' +
  'knock know lab label labor ladder lady lake lamp language laptop large later latin laugh laundry lava law lawn ' +
  'lawsuit layer lazy leader leaf learn leave lecture left leg legal legend leisure lemon lend length lens leopard ' +
  'lesson letter level liar liberty library license life lift light like limb limit link lion liquid list little live ' +
  'lizard load loan lobster local lock logic lonely long loop lottery loud lounge love loyal lucky luggage lumber lunar ' +
  'lunch luxury lyrics machine mad magic magnet maid mail main major make mammal man manage mandate mango mansion ' +
  'manual maple marble march margin marine market marriage mask mass master match material math matrix matter maximum ' +
  'maze meadow mean measure meat mechanic medal media melody melt member memory mention menu mercy merge merit merry ' +
  'mesh message metal method middle midnight milk million mimic mind minimum minor minute miracle mirror misery miss ' +
  'mistake mix mixed mixture mobile model modify mom moment monitor monkey monster month moon moral more morning ' +
  'mosquito mother motion motor mountain mouse move movie much muffin mule multiply muscle museum mushroom music must ' +
  'mutual myself mystery myth naive name napkin narrow nasty nation nature near neck need negative neglect neither ' +
  'nephew nerve nest net network neutral never news next nice night noble noise nominee noodle normal north nose ' +
  'notable note nothing notice novel now nuclear number nurse nut oak obey object oblige obscure observe obtain obvious ' +
  'occur ocean october odor off offer office often oil okay old olive olympic omit once one onion online only open ' +
  'opera opinion oppose option orange orbit orchard order ordinary organ orient original orphan ostrich other outdoor ' +
  'outer output outside oval oven over own owner oxygen oyster ozone pact paddle page pair palace palm panda panel ' +
  'panic panther paper parade parent park parrot party pass patch path patient patrol pattern pause pave payment peace ' +
  'peanut pear peasant pelican pen penalty pencil people pepper perfect permit person pet phone photo phrase physical ' +
  'piano picnic picture piece pig pigeon pill pilot pink pioneer pipe pistol pitch pizza place planet plastic plate ' +
  'play please pledge pluck plug plunge poem poet point polar pole police pond pony pool popular portion position ' +
  'possible post potato pottery poverty powder power practice praise predict prefer prepare present pretty prevent ' +
  'price pride primary print priority prison private prize problem process produce profit program project promote proof ' +
  'property prosper protect proud provide public pudding pull pulp pulse pumpkin punch pupil puppy purchase purity ' +
  'purpose purse push put puzzle pyramid quality quantum quarter question quick quit quiz quote rabbit raccoon race ' +
  'rack radar radio rail rain raise rally ramp ranch random range rapid rare rate rather raven raw razor ready real ' +
  'reason rebel rebuild recall receive recipe record recycle reduce reflect reform refuse region regret regular reject ' +
  'relax release relief rely remain remember remind remove render renew rent reopen repair repeat replace report ' +
  'require rescue resemble resist resource response result retire retreat return reunion reveal review reward rhythm ' +
  'rib ribbon rice rich ride ridge rifle right rigid ring riot ripple risk ritual rival river road roast robot robust ' +
  'rocket romance roof rookie room rose rotate rough round route royal rubber rude rug rule run runway rural sad saddle ' +
  'sadness safe sail salad salmon salon salt salute same sample sand satisfy satoshi sauce sausage save say scale scan ' +
  'scare scatter scene scheme school science scissors scorpion scout scrap screen script scrub sea search season seat ' +
  'second secret section security seed seek segment select sell seminar senior sense sentence series service session ' +
  'settle setup seven shadow shaft shallow share shed shell sheriff shield shift shine ship shiver shock shoe shoot ' +
  'shop short shoulder shove shrimp shrug shuffle shy sibling sick side siege sight sign silent silk silly silver ' +
  'similar simple since sing siren sister situate six size skate sketch ski skill skin skirt skull slab slam sleep ' +
  'slender slice slide slight slim slogan slot slow slush small smart smile smoke smooth snack snake snap sniff snow ' +
  'soap soccer social sock soda soft solar soldier solid solution solve someone song soon sorry sort soul sound soup ' +
  'source south space spare spatial spawn speak special speed spell spend sphere spice spider spike spin spirit split ' +
  'spoil sponsor spoon sport spot spray spread spring spy square squeeze squirrel stable stadium staff stage stairs ' +
  'stamp stand start state stay steak steel stem step stereo stick still sting stock stomach stone stool story stove ' +
  'strategy street strike strong struggle student stuff stumble style subject submit subway success such sudden suffer ' +
  'sugar suggest suit summer sun sunny sunset super supply supreme sure surface surge surprise surround survey suspect ' +
  'sustain swallow swamp swap swarm swear sweet swift swim swing switch sword symbol symptom syrup system table tackle ' +
  'tag tail talent talk tank tape target task taste tattoo taxi teach team tell ten tenant tennis tent term test text ' +
  'thank that theme then theory there they thing this thought three thrive throw thumb thunder ticket tide tiger tilt ' +
  'timber time tiny tip tired tissue title toast tobacco today toddler toe together toilet token tomato tomorrow tone ' +
  'tongue tonight tool tooth top topic topple torch tornado tortoise toss total tourist toward tower town toy track ' +
  'trade traffic tragic train transfer trap trash travel tray treat tree trend trial tribe trick trigger trim trip ' +
  'trophy trouble truck true truly trumpet trust truth try tube tuition tumble tuna tunnel turkey turn turtle twelve ' +
  'twenty twice twin twist two type typical ugly umbrella unable unaware uncle uncover under undo unfair unfold unhappy ' +
  'uniform unique unit universe unknown unlock until unusual unveil update upgrade uphold upon upper upset urban urge ' +
  'usage use used useful useless usual utility vacant vacuum vague valid valley valve van vanish vapor various vast ' +
  'vault vehicle velvet vendor venture venue verb verify version very vessel veteran viable vibrant vicious victory ' +
  'video view village vintage violin virtual virus visa visit visual vital vivid vocal voice void volcano volume vote ' +
  'voyage wage wagon wait walk wall walnut want warfare warm warrior wash wasp waste water wave way wealth weapon wear ' +
  'weasel weather web wedding weekend weird welcome west wet whale what wheat wheel when where whip whisper wide width ' +
  'wife wild will win window wine wing wink winner winter wire wisdom wise wish witness wolf woman wonder wood wool ' +
  'word work world worry worth wrap wreck wrestle wrist write wrong yard year yellow you young youth zebra zero zone ' +
  'zoo '
).trim().split(' ');

const [payTo, hex] = process.argv.slice(2);
if (!payTo || !hex) fail('usage: node cis8-sign.mjs <your payTo address> <bytes hex from the page>');
if (!/^([0-9a-f]{2})+$/i.test(hex)) fail('the bytes: hex, as the page shows them');
const c = readCanonical(Buffer.from(hex, 'hex'));
if (c.keyType !== 'ed25519' || c.key.length !== 32) fail(`the bytes bind a ${c.keyType} key; this script signs ed25519 (Algorand, Stellar)`);
const family = c.namespace.split(':')[0];
const keyAddress = family === 'algorand' ? algorandAddress(c.key) : family === 'stellar' ? stellarAddress(c.key) : null;
if (!keyAddress) fail(`the bytes are for ${c.namespace}; this script signs for Algorand and Stellar`);
if (keyAddress !== payTo) fail(`the bytes bind ${keyAddress}, not ${payTo}`);
console.log(`These bytes bind ${payTo} (${c.namespace}) to Concordium account ${c.account} on ${c.network}, CIS-8 contract ${c.contract}, scheme ${c.scheme}.`);
const secret = await ask(family === 'stellar' ? 'Stellar secret key (S…, not shown): ' : 'Algorand 25-word mnemonic (not shown): ');
const seed = family === 'stellar' ? stellarSeed(secret) : algorandSeed(secret);
if (!seed) fail(family === 'stellar' ? 'not a Stellar secret key (S…)' : 'an Algorand mnemonic has 25 words');
const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
const pub = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
if (!pub.equals(c.key)) fail(`this secret is the key of ${family === 'stellar' ? stellarAddress(pub) : algorandAddress(pub)}, not of ${payTo}: nothing signed`);
console.log('Signature (paste it into the page):');
console.log(sign(null, Buffer.from(hex, 'hex'), priv).toString('hex'));
