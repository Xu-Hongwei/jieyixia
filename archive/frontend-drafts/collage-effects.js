/* Generated surfaces + CSS paper space + an actual WebGL lighting pass. */
if(concept==='desktop')(()=>{
 document.body.classList.add('collage-atmosphere');
 const reduced=matchMedia('(prefers-reduced-motion: reduce)'),fine=matchMedia('(hover: hover) and (pointer: fine)');
 let hovered=null,moveFrame=0,lastPointer=null;
 const rest=card=>{if(!card)return;card.style.removeProperty('--paper-rx');card.style.removeProperty('--paper-ry');card.style.removeProperty('--paper-light-x');card.style.removeProperty('--paper-light-y');card.classList.remove('is-hovered');};
 document.addEventListener('pointermove',event=>{
  if(reduced.matches||!fine.matches)return;
  const card=event.target.closest('.pn-note');if(hovered!==card){rest(hovered);hovered=card;}
  if(!card)return;lastPointer={x:event.clientX,y:event.clientY};
  if(moveFrame)return;moveFrame=requestAnimationFrame(()=>{moveFrame=0;if(!hovered?.isConnected||!lastPointer)return;const r=hovered.getBoundingClientRect(),x=Math.max(0,Math.min(1,(lastPointer.x-r.left)/r.width)),y=Math.max(0,Math.min(1,(lastPointer.y-r.top)/r.height));hovered.style.setProperty('--paper-rx',`${(0.5-y)*2.4}deg`);hovered.style.setProperty('--paper-ry',`${(x-0.5)*3}deg`);hovered.style.setProperty('--paper-light-x',`${x*100}%`);hovered.style.setProperty('--paper-light-y',`${y*100}%`);hovered.classList.add('is-hovered');});
 },{passive:true});
 document.addEventListener('pointerout',event=>{if(hovered&&!hovered.contains(event.relatedTarget)){rest(hovered);hovered=null;}},{passive:true});
 const paper=new Image();paper.src='assets/paper-note-v4.webp';paper.onload=()=>document.body.dataset.paperAsset='ready';paper.onerror=()=>document.body.dataset.paperAsset='fallback';
 const canvas=document.createElement('canvas');canvas.className='pn-light-canvas';canvas.setAttribute('aria-hidden','true');canvas.tabIndex=-1;document.body.prepend(canvas);
 let gl=null,program=null,texture=null,ready=false,raf=0,last=0,origin=performance.now(),lost=false;
 const pointer={x:.3,y:.68},target={x:.3,y:.68};
 const allowed=()=>!reduced.matches&&fine.matches&&!document.hidden&&!lost&&new URLSearchParams(location.search).get('fx')==='on';
 const stop=()=>{cancelAnimationFrame(raf);raf=0;};
 const vertex=`attribute vec2 a_position;varying vec2 v_uv;void main(){v_uv=a_position*.5+.5;gl_Position=vec4(a_position,0.,1.);}`;
 const baseFragment=`precision mediump float;
  varying vec2 v_uv;uniform sampler2D u_surface;uniform vec2 u_resolution;uniform vec2 u_pointer;uniform float u_time;
  void main(){
   float aspect=u_resolution.x/u_resolution.y;float imageAspect=1.5;vec2 cover=vec2(1.);
   if(aspect>imageAspect)cover.y=imageAspect/aspect;else cover.x=aspect/imageAspect;
   vec2 uv=(v_uv-.5)*cover+.5;vec3 material=texture2D(u_surface,uv).rgb;
   vec2 offset=(v_uv-u_pointer)*vec2(aspect*.75,1.);float lamp=exp(-dot(offset,offset)*3.2);
   float breath=sin((v_uv.x+v_uv.y*.45)*5.5+u_time*.075)*.008;
   float edge=1.-smoothstep(.12,.85,length((v_uv-vec2(.1,.92))*vec2(.7,1.)));
   vec3 warm=vec3(1.,.92,.78)*(lamp*.048+edge*.021);
   gl_FragColor=vec4(material*(.983+breath)+warm,1.);
   }`;
 const fragment=baseFragment;
 function compile(type,source){const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){gl.deleteShader(shader);return null;}return shader;}
 let uniforms=null;
 function resize(){if(!gl)return;const scale=Math.min(1.25,1536/innerWidth);canvas.width=Math.max(1,Math.round(innerWidth*scale));canvas.height=Math.max(1,Math.round(innerHeight*scale));gl.viewport(0,0,canvas.width,canvas.height);}
 function frame(now){raf=0;if(!allowed()||!ready)return;if(now-last>=50){last=now;pointer.x+=(target.x-pointer.x)*.12;pointer.y+=(target.y-pointer.y)*.12;gl.uniform2f(uniforms.resolution,canvas.width,canvas.height);gl.uniform2f(uniforms.pointer,pointer.x,pointer.y);gl.uniform1f(uniforms.time,(now-origin)/1000);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);}raf=requestAnimationFrame(frame);}
 function start(){if(ready&&allowed()&&!raf){document.body.dataset.lightScene='webgl';raf=requestAnimationFrame(frame);}}
 function init(){
  if(gl||lost)return;
  try{
   gl=canvas.getContext('webgl',{alpha:false,antialias:false,depth:false,powerPreference:'low-power'});if(!gl){document.body.dataset.lightScene='static-unavailable';return;}
   const vs=compile(gl.VERTEX_SHADER,vertex),fs=compile(gl.FRAGMENT_SHADER,fragment);if(!vs||!fs){document.body.dataset.lightScene='static-shader';return;}
   program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);if(!gl.getProgramParameter(program,gl.LINK_STATUS)){document.body.dataset.lightScene='static-shader';return;}
   gl.useProgram(program);const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);const position=gl.getAttribLocation(program,'a_position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
   uniforms={resolution:gl.getUniformLocation(program,'u_resolution'),pointer:gl.getUniformLocation(program,'u_pointer'),time:gl.getUniformLocation(program,'u_time')};texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
   const image=new Image();image.onload=()=>{if(lost)return;gl.bindTexture(gl.TEXTURE_2D,texture);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,image);gl.uniform1i(gl.getUniformLocation(program,'u_surface'),0);resize();ready=true;document.body.dataset.loopDuration='static';start();};image.onerror=()=>document.body.dataset.lightScene='static-image';image.src='assets/window-light-v4.webp';
  }catch{document.body.dataset.lightScene='static-unavailable';stop();}
 }
 function preference(){rest(hovered);hovered=null;if(!allowed()){stop();document.body.dataset.lightScene=reduced.matches?'static-reduced':fine.matches?'static-disabled':'static-touch';}else{if(!gl)init();start();}}
 document.addEventListener('pointermove',event=>{target.x=event.clientX/innerWidth;target.y=1-event.clientY/innerHeight;},{passive:true});
 canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();lost=true;ready=false;stop();document.body.dataset.lightScene='static-context-lost';});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else preference();});
 window.addEventListener('resize',resize,{passive:true});reduced.addEventListener('change',preference);fine.addEventListener('change',preference);
 preference();
})();
