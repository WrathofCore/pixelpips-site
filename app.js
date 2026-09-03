
const RPC = "https://rpc.mainnet.chain.robinhood.com/rpc";
let provider = null;
let account = null;

function setStatus(text){
  document.querySelectorAll("#walletStatus").forEach(x => x.textContent = text);
}
function setAccount(addr){
  account = addr || null;
  if(account){
    setStatus(account.slice(0,6)+"..."+account.slice(-4));
    document.querySelectorAll("#connectWallet").forEach(b=>b.textContent="WALLET CONNECTED");
  } else {
    setStatus("NOT CONNECTED");
    document.querySelectorAll("#connectWallet").forEach(b=>b.textContent="CONNECT WALLET");
  }
  const act = document.querySelector("#activateBtn");
  if(act && !account) act.disabled = true;
}
async function connectWallet(){
  if(!window.ethereum){ setStatus("NO EVM WALLET DETECTED"); return; }
  try{
    const accounts = await window.ethereum.request({method:"eth_requestAccounts"});
    setAccount(accounts[0]);
  }catch(e){ setStatus("CONNECTION CANCELLED"); }
}
// Every page is a fresh document. The wallet already remembers this site, so ask it
// silently on load (eth_accounts never prompts) and restore the connected state.
async function restoreWallet(){
  if(!window.ethereum) return;
  try{
    const accounts = await window.ethereum.request({method:"eth_accounts"});
    if(accounts.length) setAccount(accounts[0]);
  }catch(e){}
}
document.querySelectorAll("#connectWallet").forEach(b=>b.addEventListener("click",connectWallet));
if(window.ethereum){ window.ethereum.on?.("accountsChanged", accounts => setAccount(accounts[0])); }
restoreWallet();

document.querySelectorAll("[data-copy]").forEach(btn=>{
  btn.addEventListener("click", async ()=>{
    try{ await navigator.clipboard.writeText(btn.dataset.copy); btn.textContent="COPIED"; setTimeout(()=>btn.textContent="COPY",1200); }
    catch(e){}
  });
});

const load = document.querySelector("#loadPip");
if(load){
  load.addEventListener("click",()=>{
    const id = document.querySelector("#pipId").value;
    const out = document.querySelector("#pipCheck");
    if(id === "" || Number(id)<0 || Number(id)>3333){ out.textContent="Enter a valid Pip ID from 0 to 3333."; return; }
    if(Number(id)>=3330){ out.innerHTML="<b>SPECIAL ID</b><br><span class='muted'>Special Pips do not use normal floor or tier activation accounting.</span>"; return; }
    out.innerHTML="<b>PIP "+id+"</b><br><span class='muted'>Ownership and activation state will be read from the deployed contract.</span>";
    document.querySelector("#activateBtn").disabled = !account;
  });
}
