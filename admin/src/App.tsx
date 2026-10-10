import { useEffect, useMemo, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'https://parcel-shipment-api.onrender.com';
const generateTrackingNumber = () => 'PT' + Date.now().toString().slice(-8) + Math.floor(100 + Math.random() * 900);
const request = async (method:string, path:string, body?:any) => {
  const headers:Record<string,string> = {'Content-Type':'application/json'};
  const r = await fetch(API_BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return { data };
};
const api = {
  get:(p:string)=>request('GET',p),
  post:(p:string,b:any)=>request('POST',p,b),
  put:(p:string,b:any)=>request('PUT',p,b),
  delete:(p:string)=>request('DELETE',p)
};

type EventItem = { date:string; location:string; status:string };
type Shipment = {
  id:string; trackingNumber:string; customerName:string; customerEmail:string; itemDescription:string;
  carrier:string; origin:string; destination:string; status:string; eta:string; events:EventItem[];
  createdAt:string; quantity?:number|string; country?:string; shippingMethod?:string; weight?:string;
  dimensions?:string; reference?:string; currentLocation?:string; deliveryInstructions?:string;
  latitude?:number; longitude?:number; itemImages?:string[];
};

const STATUSES = ['All','Order received','Processing','Picked up','In transit','Arrived at facility','Customs clearance','Customs cleared','Departed facility','Arrived at destination','Out for delivery','Delivered','Delivery delayed','Delivery exception','Address issue','Customs hold','Shipment returned','Shipment cancelled'];

const blank = {
  trackingNumber:'', customerName:'', itemDescription:'', country:'', quantity:1, status:'Order received',
  eta:'', origin:'', destination:'', carrier:'ParcelTrack Express', shippingMethod:'Standard',
  weight:'', dimensions:'', reference:'', customerEmail:'', currentLocation:'', deliveryInstructions:'',
  latitude:undefined as number|undefined, longitude:undefined as number|undefined, itemImages:[] as string[]
};

function App(){
  const [loading,setLoading]=useState(true);
  const [shipments,setShipments]=useState<Shipment[]>([]);
  const [filter,setFilter]=useState('All');
  const [search,setSearch]=useState('');
  const [editor,setEditor]=useState<Shipment|null|false>(false);
  const [message,setMessage]=useState('');
  const [createdTracking,setCreatedTracking]=useState('');
  const [error,setError]=useState('');

  const refresh = async()=>{ const r=await api.get('/api/admin/shipments'); setShipments(r.data.shipments||[]); };
  useEffect(()=>{void refresh().catch((e:any)=>setError(e?.message||'Could not load shipments.')).finally(()=>setLoading(false))},[]);

  const filtered=useMemo(()=>{
    let list=filter==='All'?shipments:shipments.filter(s=>s.status===filter);
    const q=search.trim().toLowerCase();
    return q?list.filter(s=>[s.trackingNumber,s.customerName,s.itemDescription,s.destination,s.status].join(' ').toLowerCase().includes(q)):list;
  },[filter,shipments,search]);

  const counts=shipments.reduce((a,s)=>({...a,[s.status]:(a[s.status]||0)+1}),{} as Record<string,number>);

  const saveShipment=async(form:any,existing:Shipment|null)=>{
    const trackingNumber=String(form.trackingNumber||generateTrackingNumber()).trim().toUpperCase();
    const destination=String(form.destination||form.country||existing?.destination||'').trim();
    const customerName=String(form.customerName||existing?.customerName||'').trim();
    const itemDescription=String(form.itemDescription||existing?.itemDescription||'').trim();
    try{
      const payload={
        ...form,
        customerName,
        itemDescription,
        country:String(form.country||destination).trim(),
        destination,
        trackingNumber,
        currentLatitude:form.latitude ?? form.currentLatitude ?? null,
        currentLongitude:form.longitude ?? form.currentLongitude ?? null,
        packageDimensions:form.dimensions ?? form.packageDimensions ?? '',
      };
      if(existing?.id) await api.put('/api/admin/shipments/'+existing.id,payload);
      else await api.post('/api/admin/shipments',{
        ...payload,
        itemDescription:form.itemDescription||form.product||'',
        origin:form.origin||'Parcel Shipment Warehouse',
        destination:form.destination||form.country||'To be confirmed'
      });
      setEditor(false); await refresh();
      if(!existing){setCreatedTracking(trackingNumber);}
      setMessage(existing?'Tracking record updated.':'Tracking record created.');
    }catch(e:any){setError(e?.message||'Could not save shipment.')}
  };

  const remove=async(s:Shipment)=>{
    if(!confirm('Delete '+s.trackingNumber+'?')) return;
    try{await api.delete('/api/admin/shipments/'+s.id);await refresh();setMessage('Tracking record deleted.')}
    catch(e:any){setError(e?.message||'Could not delete tracking record.')}
  };

  if(loading) return <div className="center-screen">Loading admin portal…</div>;
  if(createdTracking) return <div className="center-screen"><div className="success-card"><div className="success-icon">✓</div><div className="eyebrow">Tracking created successfully</div><h1>Tracking number created</h1><p>Your tracking record has been created successfully.</p><div className="tracking-copy"><strong>{createdTracking}</strong><button className="primary" onClick={()=>navigator.clipboard?.writeText(createdTracking)}>Copy tracking number</button></div><button className="secondary" onClick={()=>setCreatedTracking('')}>Back to admin panel</button></div></div>;
  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={()=>window.scrollTo({top:0,behavior:'smooth'})}><span className="brand-mark">PS</span>Parcel Shipment</button>
      <nav>
        <button onClick={()=>window.scrollTo({top:0,behavior:'smooth'})}>Admin Panel</button>
        <button onClick={()=>void refresh()}>Refresh</button>
        
      </nav>
    </header>
    {message&&<div className="toast">{message}<button onClick={()=>setMessage('')}>×</button></div>}
    {error&&<div className="global-error">{error}<button onClick={()=>setError('')}>×</button></div>}
    <main className="content admin">
      <div className="page-title">
        <div><div className="eyebrow">Private admin panel</div><h1>Create tracking numbers</h1><p>Enter the customer's name, product and destination country, then manage the tracking status.</p></div>
        <div className="page-actions"><button className="secondary" onClick={()=>void refresh()}>↻ Refresh</button><button className="primary" onClick={()=>setEditor(null)}>＋ New tracking</button></div>
      </div>
      <div className="stat-grid"><Stat label="Total" value={shipments.length}/><Stat label="In transit" value={counts['In transit']||0}/><Stat label="Out for delivery" value={counts['Out for delivery']||0}/><Stat label="Delivered" value={counts.Delivered||0}/></div>
      <div className="filters">{STATUSES.map(x=><button className={filter===x?'active':''} key={x} onClick={()=>setFilter(x)}>{x}</button>)}</div>
      <div className="admin-toolbar"><input className="admin-search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search tracking, customer, destination…"/></div>
      <div className="table">
        {filtered.map(s=><div className="row" key={s.id}>
          <div><strong>{s.trackingNumber}</strong><span>{s.customerName||'No name'} · {s.itemDescription}</span></div>
          <Status value={s.status}/>
          <div><span>{s.country||s.destination}</span><small>ETA {s.eta||'—'}</small></div>
          <div className="row-actions"><button title="Edit" onClick={()=>setEditor(s)}>✎</button><button title="Delete" onClick={()=>void remove(s)}>×</button></div>
        </div>)}
        {filtered.length===0&&<div className="empty"><strong>No tracking records found.</strong><p>Create a tracking number to get started.</p></div>}
      </div>
    </main>
    <footer><span>© 2026 Parcel Shipment</span><span>Private shipment administration.</span></footer>
    {editor!==false&&<Editor shipment={editor} close={()=>setEditor(false)} save={saveShipment} setError={setError}/>}
  </div>
}

function Editor({shipment,close,save,setError}:{shipment:Shipment|null;close:()=>void;save:(form:any,existing:Shipment|null)=>Promise<void>;setError:(s:string)=>void}){
  const [form,setForm]=useState<any>(shipment?{
    ...blank,...shipment,
    customerName:shipment.customerName||'',
    country:shipment.country||shipment.destination||'',
    destination:shipment.destination||shipment.country||'',
    itemDescription:shipment.itemDescription||'',
    latitude:shipment.currentLatitude ?? shipment.latitude,
    longitude:shipment.currentLongitude ?? shipment.longitude,
    dimensions:shipment.packageDimensions ?? shipment.dimensions ?? '',
    itemImages:shipment.itemImages||[]
  }:{...blank,trackingNumber:generateTrackingNumber()});
  const [saving,setSaving]=useState(false);
  const [imageBusy,setImageBusy]=useState(false);
  const set=(k:string,v:any)=>setForm((x:any)=>({...x,[k]:v}));
  const addImages=(files:FileList|null)=>{
    if(!files?.length)return;
    setImageBusy(true);
    Promise.all(Array.from(files).slice(0,6).map(file=>new Promise<string>((resolve,reject)=>{
      const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsDataURL(file);
    }))).then(added=>set('itemImages',[...(form.itemImages||[]),...added])).catch(()=>setError('Could not read one of the images.')).finally(()=>setImageBusy(false));
  };
  const submit=async()=>{
    const customerName=String(form.customerName||shipment?.customerName||'').trim();
    const destination=String(form.destination||form.country||shipment?.destination||'').trim();
    if(!customerName||!destination||(!shipment&&!String(form.itemDescription||'').trim())){
      setError(shipment?'Customer name and destination are required.':'Customer name, product and destination country are required.');return;
    }
    setError('');
    setSaving(true);try{await save({...form,customerName,destination,country:String(form.country||destination).trim()},shipment);}finally{setSaving(false);}
  };
  return <div className="modal-backdrop"><div className="modal">
    <div className="modal-head"><div><div className="eyebrow">Private tracking record</div><h2>{shipment?'Edit tracking':'Create tracking number'}</h2></div><button onClick={close}>×</button></div>
    <div className="form-grid">
      <label>Customer name<input value={form.customerName||''} onChange={e=>set('customerName',e.target.value)} placeholder="Full name"/></label>
      <label>Product<input value={form.itemDescription||''} onChange={e=>set('itemDescription',e.target.value)} placeholder="Product name"/></label>
      <label>Destination country<input value={form.country||''} onChange={e=>set('country',e.target.value)} placeholder="Country"/></label>
      <label>Tracking number<input value={form.trackingNumber||''} onChange={e=>set('trackingNumber',e.target.value)} placeholder="PT10004"/></label>
      <label>Quantity<input type="number" min="1" value={form.quantity??1} onChange={e=>set('quantity',e.target.value)}/></label>
      <label>Estimated delivery<input type="date" value={form.eta||''} onChange={e=>set('eta',e.target.value)}/></label>
      <label>Origin<input value={form.origin||''} onChange={e=>set('origin',e.target.value)}/></label>
      <label>Destination<input value={form.destination||''} onChange={e=>set('destination',e.target.value)}/></label>
      <label>Carrier<input value={form.carrier||''} onChange={e=>set('carrier',e.target.value)}/></label>
      <label>Shipping method<input value={form.shippingMethod||''} onChange={e=>set('shippingMethod',e.target.value)}/></label>
      <label>Package weight<input value={form.weight||''} onChange={e=>set('weight',e.target.value)}/></label>
      <label>Package dimensions<input value={form.dimensions||''} onChange={e=>set('dimensions',e.target.value)}/></label>
      <label>Order/reference number<input value={form.reference||''} onChange={e=>set('reference',e.target.value)}/></label>
      <label>Customer email<input type="email" value={form.customerEmail||''} onChange={e=>set('customerEmail',e.target.value)}/></label>
      <label>Current location<input value={form.currentLocation||''} onChange={e=>set('currentLocation',e.target.value)}/></label>
      <label>Status<select value={form.status||'Order received'} onChange={e=>set('status',e.target.value)}>{STATUSES.slice(1).map(s=><option key={s}>{s}</option>)}</select></label>
      <label>Current latitude<input type="number" step="any" value={form.latitude??''} onChange={e=>set('latitude',e.target.value===''?undefined:Number(e.target.value))} placeholder="e.g. 43.6532"/></label>
      <label>Current longitude<input type="number" step="any" value={form.longitude??''} onChange={e=>set('longitude',e.target.value===''?undefined:Number(e.target.value))} placeholder="e.g. -79.3832"/></label>
      <label className="image-upload-field">Item images<input type="file" accept="image/*" multiple onChange={e=>addImages(e.target.files)}/><small>{imageBusy?'Reading images…':'Add up to 6 photos of the item.'}</small></label>
      {form.itemImages?.length?<div className="image-preview-grid">{form.itemImages.map((src:string,i:number)=><div key={i}><img src={src} alt="Item preview"/><button type="button" onClick={()=>set('itemImages',form.itemImages.filter((_:string,j:number)=>j!==i))}>×</button></div>)}</div>:null}
      <label className="wide-field">Delivery instructions<textarea value={form.deliveryInstructions||''} onChange={e=>set('deliveryInstructions',e.target.value)} placeholder="Optional delivery instructions"/></label>
    </div>
    <div className="modal-actions"><button className="secondary" onClick={close}>Cancel</button><button className="primary" onClick={()=>void submit()} disabled={saving}>{saving?'Saving…':shipment?'Save changes':'Create tracking'}</button></div>
  </div></div>
}

const Status=({value}:{value:string})=><span className={'status '+value.toLowerCase().replaceAll(' ','-')}>{value}</span>;
const Stat=({label,value}:{label:string;value:number})=><div className="stat"><span>{label}</span><strong>{value}</strong></div>;
export default App;
