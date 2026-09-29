const video=document.getElementById('labVideo');
const toggle=document.getElementById('volumeToggle');
if(video&&toggle){
 const render=on=>{
  video.muted=!on; video.volume=on?0.65:0;
  toggle.classList.toggle('is-on',on);
  toggle.setAttribute('aria-pressed',String(on));
  toggle.setAttribute('aria-label',on?'Sound off':'Sound on');
  toggle.innerHTML=on?'<span class="volume-label">SOUND ON</span><span class="volume-icon" aria-hidden="true"></span>':'<span class="volume-label">SOUND OFF</span><span class="volume-icon" aria-hidden="true"></span>';
  try{localStorage.setItem('fizzl-lab-video-sound',on?'on':'off')}catch(e){}
 };
 let saved='off';try{saved=localStorage.getItem('fizzl-lab-video-sound')||'off'}catch(e){}
 render(saved==='on');
 const play=()=>video.play().catch(()=>{});
 play();video.addEventListener('canplay',play,{once:true});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)play()});
 toggle.addEventListener('click',async()=>{render(video.muted);try{await video.play()}catch(e){}});
}
