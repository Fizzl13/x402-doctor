const typing=document.querySelector('.typing');
if(typing){
 const text=typing.dataset.text||''; let i=0;
 const type=()=>{if(i<=text.length){typing.innerHTML=text.slice(0,i)+'<span class="cursor"></span>';i++;setTimeout(type,22)}};
 type();
}

const reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if(!reduce){document.querySelectorAll('a[href^="#"]').forEach(a=>a.addEventListener('click',e=>{const el=document.querySelector(a.getAttribute('href'));if(el){e.preventDefault();el.scrollIntoView({behavior:'smooth'});}}));}

// FIZZL background video + compact sound toggle.
// Autoplay starts muted; sound is enabled only after a user tap.
const video=document.getElementById('siteVideo');
const toggle=document.getElementById('volumeToggle');
if(video && toggle){
  const iconOff='<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 19h7l11-9v28l-11-9H8z" fill="currentColor"/><path d="M31 16l12 16M43 16L31 32" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>';
  const iconOn='<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M7 19h7l11-9v28l-11-9H7z" fill="currentColor"/><path d="M30 17c5 4 5 10 0 14M35 12c9 7 9 17 0 24M40 8c13 10 13 22 0 32" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/></svg>';
  const setState=on=>{
    video.muted=!on;
    video.defaultMuted=!on;
    video.volume=on?0.65:0;
    toggle.classList.toggle('is-on',on);
    toggle.setAttribute('aria-pressed',String(on));
    toggle.setAttribute('aria-label',on?'Geluid uitzetten':'Geluid aanzetten');
    toggle.innerHTML=`<span class="sound-label">${on?'SOUND ON':'SOUND OFF'}</span><span class="sound-icon">${on?iconOn:iconOff}</span>`;
    try{localStorage.setItem('fizzl-ai-video-sound',on?'on':'off')}catch(e){}
  };
  let saved='off';
  try{saved=localStorage.getItem('fizzl-ai-video-sound')||'off'}catch(e){}
  setState(saved==='on');
  const startVideo=()=>{
    video.muted=true;
    const p=video.play();
    if(p&&typeof p.catch==='function')p.catch(()=>{});
  };
  if(video.readyState>=2)startVideo();
  else video.addEventListener('canplay',startVideo,{once:true});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)startVideo()});
  toggle.addEventListener('click',async()=>{
    const next=video.muted;
    setState(next);
    try{await video.play()}catch(e){
      // If the browser blocks the unmute, a second tap/reload can still recover playback.
      video.muted=true;
    }
  });
}
