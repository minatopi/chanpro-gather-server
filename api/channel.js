
const {createClient}=require("@supabase/supabase-js");
const {channel}=require("@vreden/youtube_scraper");

const supabase=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const CACHE=86400000;
const HOSTS=["youtube.com","www.youtube.com","m.youtube.com"];

function normalizeURL(v){
 v=String(v||"").trim();
 if(/^@[\w.-]+$/.test(v))return "https://www.youtube.com/"+v;
 if(!/^https:\/\//i.test(v))throw Error("HTTPS YouTube URL required");
 const u=new URL(v);
 if(!HOSTS.includes(u.hostname.toLowerCase())||u.username||u.password)throw Error("Invalid YouTube URL");
 return "https://www.youtube.com"+u.pathname;
}

function channelKey(u){
 const p=new URL(u).pathname.split("/").filter(Boolean);
 return p[0]?.startsWith("@")||["channel","c","user"].includes(p[0])?p.slice(0,p[0]==="channel"||p[0]==="c"||p[0]==="user"?2:1).join("/"):"";
}

function parseCount(v){
 if(v==null)return null;
 if(typeof v==="number")return Number.isFinite(v)&&v>=0?Math.round(v):null;
 if(typeof v==="object"){
  v=v.simpleText||v.accessibility?.accessibilityData?.label||v.runs?.map(x=>x.text||"").join("");
 }
 if(!v)return null;
 const s=String(v).replace(/,/g,"").replace(/\s/g,"");
 const jp=s.match(/([\d.]+)(億|万)/);
 if(jp)return Math.round(Number(jp[1])*(jp[2]==="億"?1e8:1e4));
 const en=s.match(/([\d.]+)([KMB])/i);
 if(en)return Math.round(Number(en[1])*({K:1e3,M:1e6,B:1e9}[en[2].toUpperCase()]));
 const n=s.match(/([\d.]+)/);
 return n&&/subscriber|登録者/i.test(s)?Math.round(Number(n[1])):null;
}

function extractJSON(s,pos){
 const start=s.indexOf("{",pos);
 if(start<0)return null;
 let depth=0,str=false,esc=false;
 for(let i=start;i<s.length;i++){
  const c=s[i];
  if(str){if(esc)esc=false;else if(c==="\\")esc=true;else if(c==='"')str=false;continue;}
  if(c==='"')str=true;
  else if(c==="{")depth++;
  else if(c==="}"&&!--depth)return s.slice(start,i+1);
 }
 return null;
}

function findCount(o){
 if(!o||typeof o!=="object")return null;
 if(Array.isArray(o)){for(const x of o){const n=findCount(x);if(n!==null)return n;}return null;}
 for(const k of ["subscriberCountText","subscriberCount"]){
  if(o[k]!=null){const n=parseCount(o[k]);if(n!==null)return n;}
 }
 for(const v of Object.values(o)){const n=findCount(v);if(n!==null)return n;}
 return null;
}

async function getHTML(url){
 const u=new URL(url);
 u.pathname=u.pathname.replace(/\/+$/,"")+"/about";
 const r=await fetch(u.toString(),{
  headers:{
   "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
   "Accept-Language":"ja,en-US;q=0.9,en;q=0.8"
  },
  signal:AbortSignal.timeout(20000)
 });
 if(!r.ok)throw Error("YouTube HTTP "+r.status);
 return await r.text();
}

async function getSubscribersFromHTML(url){
 const html=await getHTML(url);
 const patterns=[/ytInitialData\s*=/,/window\["ytInitialData"\]\s*=/];
 for(const p of patterns){
  const m=p.exec(html);
  if(!m)continue;
  try{
   const j=extractJSON(html,m.index+m[0].length);
   if(j){const n=findCount(JSON.parse(j));if(n!==null)return n;}
  }catch(e){console.error("InitialData:",e.message);}
 }
 const patterns2=[
  /"subscriberCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+)"/,
  /"subscriberCountText"\s*:\s*"([^"]+)"/,
  /([\d,.]+\s*(?:億|万|[KMB])?)\s*人の登録者/i,
  /([\d,.]+\s*(?:億|万|[KMB])?)\s*subscribers/i,
  /<meta[^>]+itemprop=["']subscriberCount["'][^>]+content=["']([^"']+)/i
 ];
 for(const p of patterns2){
  const m=html.match(p);
  if(m){const n=parseCount(m[1]);if(n!==null)return n;}
 }
 console.warn("Subscriber count not found. HTML length:",html.length);
 return null;
}

module.exports=async(req,res)=>{
 res.setHeader("Access-Control-Allow-Origin","*");
 res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
 res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization, apikey, x-client-info");
 if(req.method==="OPTIONS")return res.status(204).end();
 if(req.method!=="GET")return res.status(405).json({status:"error",message:"GET only"});
 if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({status:"error",message:"Supabase configuration missing"});
 let url,key;
 try{
  url=normalizeURL(req.query.url);
  key=channelKey(url);
  if(!key)throw Error("Channel handle or channel ID required");
 }catch(e){return res.status(400).json({status:"error",message:e.message});}

 try{
  const {data:cached,error:cacheError}=await supabase.from("youtube_channels").select("*").eq("id",key).maybeSingle();
  if(cacheError)console.error("Cache read:",cacheError.message);

  const age=cached?.updated_at?Date.now()-new Date(cached.updated_at).getTime():Infinity;
  const cachedCount=parseCount(cached?.subscribers);

  if(cached&&age>=0&&age<CACHE&&cachedCount!==null){
   return res.status(200).json({status:"success",source:"database_cache",data:{
    channelName:cached.channel_name,
    subscribers:cachedCount,
    avatarUrl:cached.avatar_url,
    description:cached.description,
    bannerUrl:cached.banner_url,
    isVerified:cached.is_verified,
    updatedAt:cached.updated_at
   }});
  }

  let scraped=null;
  try{
   scraped=await channel(url);
   console.log("Scraper result:",JSON.stringify({
    title:scraped?.title,
    subscribers:scraped?.subscribers,
    keys:scraped?Object.keys(scraped):[]
   }));
  }catch(e){console.error("Scraper error:",e.message);}

  let subscribers=parseCount(scraped?.subscribers??scraped?.subscriberCount??scraped?.subscriberCountText);

  if(subscribers===null){
   console.log("Subscriber count missing. Fetching YouTube HTML:",url);
   try{subscribers=await getSubscribersFromHTML(url);}
   catch(e){console.error("HTML scraping error:",e.message);}
  }

  if(subscribers===null&&cachedCount!==null){
   subscribers=cachedCount;
   console.log("Using previous cached subscriber count:",subscribers);
  }

  let name=scraped?.title||scraped?.name||cached?.channel_name||null;
  let avatar=scraped?.avatar||scraped?.thumbnail||cached?.avatar_url||null;
  let description=scraped?.description||cached?.description||"";
  let banner=scraped?.banner||cached?.banner_url||null;
  let verified=scraped?.verified!==undefined?Boolean(scraped.verified):Boolean(cached?.is_verified);

  if(!name){
   try{
    const h=await getHTML(url);
    const m=h.match(/"channelMetadataRenderer"\s*:\s*\{[\s\S]*?"title"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if(m)name=JSON.parse('"'+m[1]+'"');
   }catch(e){console.error("Channel name extraction:",e.message);}
  }

  if(!name){
   return res.status(502).json({status:"error",message:"Channel information unavailable",subscribers});
  }

  const updatedAt=new Date().toISOString();
  const data={
   id:key,
   channel_name:name,
   subscribers,
   avatar_url:avatar,
   description,
   banner_url:banner,
   is_verified:verified,
   updated_at:updatedAt
  };

  const {error:saveError}=await supabase.from("youtube_channels").upsert(data,{onConflict:"id"});
  if(saveError)console.error("Supabase save error:",saveError.message);

  console.log("Final subscriber count:",subscribers);

  return res.status(200).json({
   status:"success",
   source:"youtube_live",
   data:{
    channelName:name,
    subscribers,
    avatarUrl:avatar,
    description,
    bannerUrl:banner,
    isVerified:verified,
    updatedAt
   }
  });

 }catch(e){
  console.error("Channel API error:",e);
  return res.status(500).json({status:"error",message:"YouTube channel retrieval failed"});
 }
};
