'use strict';
const F=require('../frame');
// Pixel-only background subtraction over the entire closing row and its label.
// No candidate boxes, expected text or archive answers influence the transform.
function transform(frame,bar,channel=0){
 const s=bar.bh/11;
 if(!Number.isFinite(s)||s<.6||s>3)return null;
 const box={left:bar.bx+110*s,top:bar.by+bar.bh+3*s,width:185*s,height:32*s},p=F.region(frame,box.left,box.top,box.width,box.height);
 if(!p)return null;
 const radius=Math.max(2,Math.round(3*s)),values=new Uint8Array(p.width*p.height),out={...frame,data:Buffer.from(frame.data)};
 for(let i=0;i<values.length;i++)values[i]=p.buf[4*i+channel];
 for(let y=0;y<p.height;y++)for(let x=0;x<p.width;x++){
  const neighbors=[];for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++){const xx=x+dx,yy=y+dy;if(xx>=0&&xx<p.width&&yy>=0&&yy<p.height)neighbors.push(values[yy*p.width+xx]);}
  neighbors.sort((a,b)=>a-b);const residual=Math.max(0,values[y*p.width+x]-neighbors[Math.floor(neighbors.length*.3)]);
  const value=25+Math.min(230,residual*6),at=((p.top+y)*frame.width+p.left+x)*4;
  out.data[at]=value;out.data[at+1]=value;out.data[at+2]=value;
 }
 return {frame:out,box:{left:p.left,top:p.top,width:p.width,height:p.height},channel};
}
module.exports={transform};
