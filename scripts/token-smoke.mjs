// Read a public LinkedIn article (text only).
const url = 'https://www.linkedin.com/pulse/what-onboarding-700-x402-enabled-api-endpoints-teaching-pickett-vciec';
const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', accept: 'text/html', 'accept-language': 'en' }, redirect: 'follow' });
const html = await r.text();
console.log('HTTP', r.status, r.url, html.length);
const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
console.log('TITLE', title);
const body = (html.match(/<div[^>]*class="[^"]*article-main__content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/) || [])[1] || html;
const text = body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<\/(p|h\d|li|br)>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');
console.log(text.slice(0, 12000));
