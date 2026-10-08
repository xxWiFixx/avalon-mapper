import React,{useEffect,useRef} from 'react';
import {useLanguage} from '../localization.jsx';
import '../../../app/ui/server-help.js';
const images={
  'server-create.jpg':new URL('../../../app/assets/server-help/server-create.jpg',import.meta.url).href,
  'server-roles.png':new URL('../../../app/assets/server-help/server-roles.png',import.meta.url).href
};
export default function ServerHelp(){
  const {t,language}=useLanguage(),host=useRef(null);
  useEffect(()=>{
    return globalThis.AvalonServerHelp.mount(host.current,{t,imageUrl:name=>images[name]});
  },[language,t]);
  return <div ref={host}/>;
}
