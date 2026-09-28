// Read the current fizzl.eu page: structure, text, links, assets.
const h = await (await fetch('https://fizzl.eu/')).text();
console.log('HEAD', (h.match(/<head>[\s\S]*?<\/head>/) || [''])[0].replace(/<style[\s\S]*?<\/style>/g, '<style…>').slice(0, 1500));
const body = (h.match(/<body[\s\S]*<\/body>/) || [h])[0];
console.log('SECTIONS', [...body.matchAll(/<(section|header|footer|nav|h1|h2|h3)[^>]*>/g)].map((m) => m[0]).join(' '));
console.log('TEXT', body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 3500));
console.log('LINKS', [...new Set([...body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]))].join(' '));
console.log('ASSETS', [...new Set([...h.matchAll(/(?:src|href)="([^"]+\.(?:css|js|png|jpg|jpeg|svg|webp|ico))"/g)].map((m) => m[1]))].join(' '));
console.log('STYLE', ((h.match(/<style[\s\S]*?<\/style>/) || [''])[0]).slice(0, 900));
