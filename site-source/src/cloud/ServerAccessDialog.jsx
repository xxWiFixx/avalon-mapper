import {useEffect,useRef} from 'react';
import {useLanguage} from '../localization.jsx';
import '../../../app/ui/server-access-ui.js';
import '../../../app/ui/server-access.css';
export default function ServerAccessDialog({map,accountId,kind,rpc,onClose,onChanged}){
 const {t}=useLanguage(),anchor=useRef(null),changed=useRef(onChanged),close=useRef(onClose);
 changed.current=onChanged;close.current=onClose;
 useEffect(()=>{
   let alive=true;
   const ui=globalThis.AvalonServerAccess.open({map:{...map},accountId,kind,rpc,t,isCurrent:()=>alive,
     host:anchor.current.closest('.mapper-web')||document.body,onChanged:()=>changed.current?.()});
   const dialog=anchor.current.closest('.mapper-web')?.querySelector('.server-dialog');
   const finish=()=>{if(alive)close.current?.();};dialog?.addEventListener('close',finish);
   return()=>{alive=false;dialog?.removeEventListener('close',finish);ui?.close();};
 },[map.id,accountId,kind,rpc,t]);
 return <span ref={anchor} hidden/>;
}
