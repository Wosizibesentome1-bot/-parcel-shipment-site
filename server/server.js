const express=require('express');
const cors=require('cors');
const crypto=require('crypto');
const {Pool}=require('pg');

const app=express();
app.use(express.json({limit:'8mb'}));
app.use(cors({origin:true}));

const PORT=process.env.PORT||10000;
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||'change-this-password';
const DATABASE_URL=process.env.DATABASE_URL;
if(!DATABASE_URL) console.warn('DATABASE_URL is not set. Persistent storage is unavailable until it is configured.');

const pool=DATABASE_URL?new Pool({
  connectionString:DATABASE_URL,
  ssl:{rejectUnauthorized:false},
  family:4,
  max:5
}):null;

const now=()=>new Date().toISOString();
const tokens=new Map();

async function initDb(){
  if(!pool)return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shipments (
      id TEXT PRIMARY KEY,
      tracking_number TEXT NOT NULL UNIQUE,
      customer_name TEXT NOT NULL,
      customer_email TEXT,
      item_description TEXT NOT NULL,
      carrier TEXT,
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      status TEXT,
      eta TEXT,
      shipping_method TEXT,
      weight TEXT,
      reference TEXT,
      current_location TEXT,
      current_latitude DOUBLE PRECISION,
      current_longitude DOUBLE PRECISION,
      quantity INTEGER,
      package_dimensions TEXT,
      delivery_instructions TEXT,
      item_images JSONB DEFAULT '[]'::jsonb,
      events JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS shipments_tracking_idx ON shipments (UPPER(tracking_number))');
  const count=(await pool.query('SELECT COUNT(*)::int AS count FROM shipments')).rows[0].count;
  if(count===0){
    const demo=[
      {id:'1',trackingNumber:'PT10001',customerName:'Demo Customer',customerEmail:'demo@example.com',itemDescription:'Wireless Headphones',carrier:'ParcelTrack',origin:'Toronto, Canada',destination:'Zurich, Switzerland',status:'In transit',eta:'2026-10-02',events:[{date:'Sep 24, 2026 · 09:18',location:'Toronto, Canada',status:'Shipment picked up'},{date:'Sep 24, 2026 · 16:42',location:'Toronto, Canada',status:'Processed at facility'},{date:'Sep 25, 2026 · 02:10',location:'Toronto, Canada',status:'Departed international hub'}]},
      {id:'2',trackingNumber:'PT10002',customerName:'Demo Customer',customerEmail:'demo@example.com',itemDescription:'Smart Watch',carrier:'ParcelTrack',origin:'Geneva, Switzerland',destination:'Zurich, Switzerland',status:'Out for delivery',eta:'2026-09-25',events:[{date:'Sep 23, 2026 · 10:12',location:'Geneva, Switzerland',status:'Shipment picked up'},{date:'Sep 25, 2026 · 06:31',location:'Zurich, Switzerland',status:'Arrived at local facility'}]}
    ];
    for(const s of demo) await saveShipment(s);
  }
}

function rowToShipment(r){
  return {
    id:r.id,trackingNumber:r.tracking_number,customerName:r.customer_name,customerEmail:r.customer_email,
    itemDescription:r.item_description,carrier:r.carrier,origin:r.origin,destination:r.destination,status:r.status,
    eta:r.eta,shippingMethod:r.shipping_method,weight:r.weight,reference:r.reference,currentLocation:r.current_location,
    currentLatitude:r.current_latitude,currentLongitude:r.current_longitude,quantity:r.quantity,
    packageDimensions:r.package_dimensions,deliveryInstructions:r.delivery_instructions,itemImages:r.item_images||[],
    events:r.events||[],createdAt:r.created_at?.toISOString?.()||r.created_at,updatedAt:r.updated_at?.toISOString?.()||r.updated_at
  };
}

async function saveShipment(s){
  await pool.query(`
    INSERT INTO shipments (
      id,tracking_number,customer_name,customer_email,item_description,carrier,origin,destination,status,eta,
      shipping_method,weight,reference,current_location,current_latitude,current_longitude,quantity,
      package_dimensions,delivery_instructions,item_images,events,created_at,updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
  `,[
    s.id,s.trackingNumber,s.customerName,s.customerEmail||null,s.itemDescription,s.carrier||null,s.origin,s.destination,
    s.status||'Order received',s.eta||null,s.shippingMethod||'Standard',s.weight||null,s.reference||null,
    s.currentLocation||null,s.currentLatitude??null,s.currentLongitude??null,s.quantity??null,
    s.packageDimensions||null,s.deliveryInstructions||null,JSON.stringify(s.itemImages||[]),JSON.stringify(s.events||[]),
    s.createdAt||now(),s.updatedAt||null
  ]);
}

async function getAllShipments(){
  const {rows}=await pool.query('SELECT * FROM shipments ORDER BY created_at DESC');
  return rows.map(rowToShipment);
}

async function getShipmentById(id){
  const {rows}=await pool.query('SELECT * FROM shipments WHERE id=$1',[id]);
  return rows[0]?rowToShipment(rows[0]):null;
}

async function getShipmentByTracking(tracking){
  const {rows}=await pool.query('SELECT * FROM shipments WHERE UPPER(tracking_number)=UPPER($1) LIMIT 1',[tracking]);
  return rows[0]?rowToShipment(rows[0]):null;
}

function publicShipment(s){
  return {
    id:s.id,tracking:s.trackingNumber,customerName:s.customerName,product:s.itemDescription,country:s.destination,
    status:s.status,eta:s.eta,origin:s.origin,destination:s.destination,carrier:s.carrier,shippingMethod:s.shippingMethod||'Standard',
    weight:s.weight,reference:s.reference,currentLocation:s.currentLocation||s.destination,customerEmail:s.customerEmail,
    lastUpdated:s.updatedAt||s.createdAt,
    events:(s.events||[]).map((e,i)=>({title:e.status,location:e.location,time:e.date,done:i<(s.events||[]).length-1||s.status==='Delivered'})),
    proofOfDelivery:s.status==='Delivered'?'Delivered to recipient at destination.':undefined
  };
}

function admin(req,res,next){
  const t=req.get('x-admin-token');
  if(!t||!tokens.has(t))return res.status(401).json({error:'Admin access required'});
  next();
}

app.get('/api/_healthcheck',async(req,res)=>{
  try{
    if(!pool)return res.status(503).json({message:'Database not configured'});
    await pool.query('SELECT 1');
    res.json({message:'Success',database:'connected'});
  }catch(e){res.status(503).json({message:'Database unavailable'});}
});

app.post('/api/admin/login',(req,res)=>{
  if(req.body?.password!==ADMIN_PASSWORD)return res.status(401).json({error:'Incorrect password'});
  const token=crypto.randomBytes(24).toString('hex');
  tokens.set(token,{createdAt:now()});
  res.json({token});
});

app.post('/api/admin/logout',(req,res)=>{
  tokens.delete(req.get('x-admin-token'));
  res.json({ok:true});
});

app.get('/api/admin/shipments',admin,async(req,res)=>{
  try{res.json({shipments:await getAllShipments()});}
  catch(e){res.status(500).json({error:'Unable to load shipments'});}
});

app.post('/api/admin/shipments',admin,async(req,res)=>{
  try{
    const b=req.body||{};
    if(!b.trackingNumber||!b.customerName||!b.itemDescription||!b.origin||!b.destination)
      return res.status(400).json({error:'Required fields are missing'});
    const tracking=String(b.trackingNumber).toUpperCase();
    if(await getShipmentByTracking(tracking))return res.status(409).json({error:'Tracking number already exists'});
    const s={...b,id:crypto.randomUUID(),trackingNumber:tracking,events:Array.isArray(b.events)?b.events:[],createdAt:now()};
    await saveShipment(s);
    res.status(201).json({shipment:s});
  }catch(e){res.status(500).json({error:'Unable to create shipment'});}
});

app.put('/api/admin/shipments/:id',admin,async(req,res)=>{
  try{
    const existing=await getShipmentById(req.params.id);
    if(!existing)return res.status(404).json({error:'Shipment not found'});
    const body=req.body||{};
    const next={...existing,...body,id:existing.id,trackingNumber:String(body.trackingNumber||existing.trackingNumber).toUpperCase(),updatedAt:now()};
    const duplicate=await getShipmentByTracking(next.trackingNumber);
    if(duplicate&&duplicate.id!==existing.id)return res.status(409).json({error:'Tracking number already exists'});
    await pool.query(`
      UPDATE shipments SET tracking_number=$1,customer_name=$2,customer_email=$3,item_description=$4,carrier=$5,
      origin=$6,destination=$7,status=$8,eta=$9,shipping_method=$10,weight=$11,reference=$12,current_location=$13,
      current_latitude=$14,current_longitude=$15,quantity=$16,package_dimensions=$17,delivery_instructions=$18,
      item_images=$19,events=$20,updated_at=$21 WHERE id=$22
    `,[
      next.trackingNumber,next.customerName,next.customerEmail||null,next.itemDescription,next.carrier||null,next.origin,next.destination,
      next.status||'Order received',next.eta||null,next.shippingMethod||'Standard',next.weight||null,next.reference||null,
      next.currentLocation||null,next.currentLatitude??null,next.currentLongitude??null,next.quantity??null,
      next.packageDimensions||null,next.deliveryInstructions||null,JSON.stringify(next.itemImages||[]),JSON.stringify(next.events||[]),
      next.updatedAt,next.id
    ]);
    res.json({shipment:await getShipmentById(next.id)});
  }catch(e){res.status(500).json({error:'Unable to update shipment'});}
});

app.delete('/api/admin/shipments/:id',admin,async(req,res)=>{
  try{
    const result=await pool.query('DELETE FROM shipments WHERE id=$1',[req.params.id]);
    if(!result.rowCount)return res.status(404).json({error:'Shipment not found'});
    res.json({deleted:true});
  }catch(e){res.status(500).json({error:'Unable to delete shipment'});}
});

app.post('/api/admin/shipments/events',admin,async(req,res)=>{
  try{
    const b=req.body||{};
    const s=await getShipmentByTracking(b.trackingNumber||'');
    if(!s)return res.status(404).json({error:'Shipment not found'});
    const events=[...(s.events||[]),{date:now(),location:b.location||'',status:b.status||'Shipment updated'}];
    await pool.query('UPDATE shipments SET events=$1,status=$2,updated_at=$3 WHERE id=$4',[JSON.stringify(events),b.status||s.status,now(),s.id]);
    res.json({shipment:await getShipmentById(s.id)});
  }catch(e){res.status(500).json({error:'Unable to add shipment update'});}
});

app.get('/api/shipments/:tracking',async(req,res)=>{
  try{
    const s=await getShipmentByTracking(req.params.tracking);
    if(!s)return res.status(404).json({error:'Tracking number not found'});
    res.json({shipment:publicShipment(s)});
  }catch(e){res.status(500).json({error:'Unable to load tracking information'});}
});

app.get('/api/me',(req,res)=>{
  const email=req.get('x-user-email');
  res.json({user:email?{userId:email,email,name:email.split('@')[0],role:'customer'}:null});
});

app.get('/api/my-shipments',async(req,res)=>{
  try{
    const email=(req.get('x-user-email')||'').toLowerCase();
    const shipments=(await getAllShipments()).filter(s=>(s.customerEmail||'').toLowerCase()===email).map(publicShipment);
    res.json({shipments});
  }catch(e){res.status(500).json({error:'Unable to load shipments'});}
});

app.post('/api/support/tickets',(req,res)=>res.status(201).json({ticketId:crypto.randomUUID()}));

initDb().then(()=>{
  app.listen(PORT,'0.0.0.0',()=>console.log('Parcel Shipment API listening on '+PORT));
}).catch(err=>{
  console.error('Database initialization failed:',err);
  process.exit(1);
});
