'use strict';
// Used only after the full digit/unit and edge checks succeeded. The remaining
// label word must be present too; geometry alone does not authorize a timer.
function confirms(frame,bar,candidate,texts){
 const s=bar?.bh/11,r=candidate?.roi;
 if(!r||!Number.isFinite(s)||s<.6||s>3)return false;
 const deltaTop=r.top-bar.by-bar.bh,end=r.left+r.width-bar.bx;
 if(r.left<bar.bx+194*s||r.width>80*s||deltaTop<7*s||deltaTop>18*s||r.top+r.height>bar.by+bar.bh+30*s||Math.abs(end-265*s)>9*s)return false;
 if(r.left<0||r.top<0||r.left+r.width>frame.width||r.top+r.height>frame.height)return false;
 return texts.some(text=>/(?:^|\s)через(?:\s|$)/iu.test(String(text||'')));
}
module.exports={confirms};
