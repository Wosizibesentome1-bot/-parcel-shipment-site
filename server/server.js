const express=require('express');
const cors=require('cors');
const crypto=require('crypto');
const dns=require('dns');
const {Pool}=require('pg');
try{dns.setDefaultResultOrder('ipv4first')}catch{}
const ipv4Lookup=(hostname,options,callback)=>dns.lookup(hostname,{family:4,all:false},callback);

const app=express();
app.use(express.json({limit:'8mb'}));
app.use(cors({origin:true}));

const PORT=process.env.PORT||10000;
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||'change-this-password';
const DATABASE_URL=process.env.DATABASE_URL;
const RESEND_API_KEY=process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL=process.env.RESEND_FROM_EMAIL||'Parcel Shipment <onboarding@resend.dev>';
if(!DATABASE_URL) console.warn('DATABASE_URL is not set. Persistent storage is unavailable until it is configured.');

const pool=DATABASE_URL?new Pool({
  connectionString:DATABASE_URL,
  ssl:{rejectUnauthorized:false},
  max:5,
  family:4,
  lookup:ipv4Lookup,
  connectionTimeoutMillis:10000,
  idleTimeoutMillis:30000
}):null;

const now=()=>new Date().toISOString();
const tokens=new Map();
const hashPassword=(password,salt=crypto.randomBytes(16).toString('hex'))=>{
  const hash=crypto.scryptSync(String(password),salt,64).toString('hex');
  return {salt,hash};
};
const verifyPassword=(password,salt,hash)=>{
  const actual=crypto.scryptSync(String(password),salt,64);
  const expected=Buffer.from(hash,'hex');
  return actual.length===expected.length&&crypto.timingSafeEqual(actual,expected);
};
const makeSessionToken=()=>crypto.randomBytes(32).toString('hex');
const sessionHash=token=>crypto.createHash('sha256').update(String(token)).digest('hex');
async function getCustomerBySession(req){
  const auth=req.get('authorization')||'';
  const token=auth.startsWith('Bearer ')?auth.slice(7):'';
  if(!token||!pool)return null;
  const {rows}=await pool.query(`
    SELECT c.* FROM customer_sessions cs JOIN customers c ON c.id=cs.customer_id
    WHERE cs.token_hash=$1 AND cs.expires_at>NOW()
  `,[sessionHash(token)]);
  return rows[0]||null;
}
function customerPublic(c){
  if(!c)return null;
  return {userId:c.id,firstName:c.first_name,lastName:c.last_name,middleName:c.middle_name||'',username:c.username,email:c.email,phone:c.phone,country:c.country,address:c.address_line1,city:c.city,state:c.state,postalCode:c.postal_code,role:'customer'};
}

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      middle_name TEXT,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL,
      address_line1 TEXT,
      city TEXT,
      state TEXT,
      country TEXT NOT NULL,
      postal_code TEXT,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_sessions (
      token_hash TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_tracking (
      customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(customer_id,shipment_id)
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

async function sendShipmentReceivedEmail(shipment){
  if(!shipment.customerEmail||!RESEND_API_KEY){
    if(shipment.customerEmail) console.warn('Shipment email not sent: RESEND_API_KEY is not configured.');
    return {sent:false,reason:RESEND_API_KEY?'no_email':'no_api_key'};
  }
  const firstName=String(shipment.customerName||'Customer').trim().split(/\\s+/)[0]||'Customer';
  const tracking=shipment.trackingNumber;
  const eta=shipment.eta||'To be confirmed';
  const destination=shipment.destination||'your destination';
  const product=shipment.itemDescription||'your shipment';
  const html=`
  <div style="margin:0;background:#f5f7fb;padding:32px 16px;font-family:Arial,sans-serif;color:#172033">
    <div style="max-width:620px;margin:auto;background:#fff;border:1px solid #e5e9f0;border-radius:14px;overflow:hidden">
      <div style="background:#071521;padding:26px 30px;color:#fff"><div style="font-size:13px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700">Parcel Shipment</div><h1 style="margin:10px 0 0;font-size:27px">Shipment order received</h1></div>
      <div style="padding:30px">
        <p style="font-size:16px">Hello ${firstName},</p>
        <p style="line-height:1.65;color:#526074">Your shipment order has been received and your tracking record has been created successfully. You can use your tracking number to view the latest shipment updates.</p>
        <div style="background:#f7f9fc;border:1px solid #e3e8ef;border-radius:10px;padding:18px;margin:22px 0">
          <div style="font-size:12px;color:#718096;text-transform:uppercase;font-weight:700">Tracking number</div>
          <div style="font-size:22px;font-weight:800;margin-top:6px;letter-spacing:.5px">${tracking}</div>
          <div style="margin-top:15px;font-size:14px;color:#526074"><strong>Shipment:</strong> ${product}</div>
          <div style="margin-top:7px;font-size:14px;color:#526074"><strong>Destination:</strong> ${destination}</div>
          <div style="margin-top:7px;font-size:14px;color:#526074"><strong>Estimated delivery:</strong> ${eta}</div>
        </div>
        <p style="line-height:1.65;color:#526074">Your shipment is now in our tracking system. Please keep your tracking number for reference. Further updates will appear as your shipment progresses through each stage of delivery.</p>
        <p style="margin-top:26px;color:#526074">Thank you for choosing Parcel Shipment.</p>
        <div style="margin-top:28px;padding-top:18px;border-top:1px solid #edf0f4;font-size:12px;color:#8792a2">This is an automated shipment notification. Please do not reply to this email.</div>
      </div>
    </div>
  </div>`;
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:RESEND_FROM_EMAIL,to:[shipment.customerEmail],subject:'Your shipment order has been received — '+tracking,html})});
  if(!response.ok){const detail=await response.text();console.error('Shipment email failed:',detail);return {sent:false,reason:'provider_error'};}
  return {sent:true};
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

app.get('/api/admin/shipments',async(req,res)=>{
  try{res.json({shipments:await getAllShipments()});}
  catch(e){res.status(500).json({error:'Unable to load shipments'});}
});

app.post('/api/admin/shipments',async(req,res)=>{
  try{
    const b=req.body||{};
    if(!b.trackingNumber||!b.customerName||!b.itemDescription||!b.origin||!b.destination)
      return res.status(400).json({error:'Required fields are missing'});
    const tracking=String(b.trackingNumber).toUpperCase();
    if(await getShipmentByTracking(tracking))return res.status(409).json({error:'Tracking number already exists'});
    const s={...b,id:crypto.randomUUID(),trackingNumber:tracking,events:Array.isArray(b.events)?b.events:[],createdAt:now()};
    await saveShipment(s);
    const email=await sendShipmentReceivedEmail(s);
    res.status(201).json({shipment:s,email});
  }catch(e){res.status(500).json({error:'Unable to create shipment'});}
});

app.put('/api/admin/shipments/:id',async(req,res)=>{
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

app.delete('/api/admin/shipments/:id',async(req,res)=>{
  try{
    const result=await pool.query('DELETE FROM shipments WHERE id=$1',[req.params.id]);
    if(!result.rowCount)return res.status(404).json({error:'Shipment not found'});
    res.json({deleted:true});
  }catch(e){res.status(500).json({error:'Unable to delete shipment'});}
});

app.post('/api/admin/shipments/events',async(req,res)=>{
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

app.post('/api/auth/register',async(req,res)=>{
  try{
    const b=req.body||{};
    const required=['firstName','lastName','username','email','phone','country','password','trackingNumber'];
    if(required.some(k=>!String(b[k]||'').trim()))return res.status(400).json({error:'Please complete all required fields.'});
    if(String(b.password).length<8)return res.status(400).json({error:'Password must be at least 8 characters.'});
    if(b.password!==b.confirmPassword)return res.status(400).json({error:'Passwords do not match.'});
    const username=String(b.username).trim().replace(/^@/,'').toLowerCase();
    const email=String(b.email).trim().toLowerCase();
    const tracking=String(b.trackingNumber).trim().toUpperCase();
    if(!/^[a-z0-9._-]{3,30}$/.test(username))return res.status(400).json({error:'Username must be 3-30 characters and use letters, numbers, dots, underscores or hyphens.'});
    const existing=await pool.query('SELECT id FROM customers WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($2) LIMIT 1',[username,email]);
    if(existing.rows[0])return res.status(409).json({error:'That username or email is already registered.'});
    const shipment=await getShipmentByTracking(tracking);
    if(!shipment)return res.status(400).json({error:'The tracking number could not be found.'});
    const {salt,hash}=hashPassword(b.password);
    const id=crypto.randomUUID();
    await pool.query(`
      INSERT INTO customers(id,first_name,last_name,middle_name,username,email,phone,address_line1,city,state,country,postal_code,password_salt,password_hash,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    `,[id,String(b.firstName).trim(),String(b.lastName).trim(),String(b.middleName||'').trim()||null,username,email,String(b.phone).trim(),String(b.address||'').trim()||null,String(b.city||'').trim()||null,String(b.state||'').trim()||null,String(b.country).trim(),String(b.postalCode||'').trim()||null,salt,hash,now()]);
    await pool.query('INSERT INTO customer_tracking(customer_id,shipment_id,created_at) VALUES($1,$2,$3)',[id,shipment.id,now()]);
    const token=makeSessionToken();
    await pool.query('INSERT INTO customer_sessions(token_hash,customer_id,expires_at,created_at) VALUES($1,$2,NOW()+INTERVAL \'180 days\',$3)',[sessionHash(token),id,now()]);
    const customer=(await pool.query('SELECT * FROM customers WHERE id=$1',[id])).rows[0];
    res.status(201).json({token,user:customerPublic(customer)});
  }catch(e){res.status(500).json({error:'Unable to create account.'});}
});
app.post('/api/auth/login',async(req,res)=>{
  try{
    const usernameOrEmail=String(req.body?.usernameOrEmail||'').trim().toLowerCase();
    const password=String(req.body?.password||'');
    const {rows}=await pool.query('SELECT * FROM customers WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($1) LIMIT 1',[usernameOrEmail]);
    const customer=rows[0];
    if(!customer||!verifyPassword(password,customer.password_salt,customer.password_hash))return res.status(401).json({error:'Incorrect username/email or password.'});
    const token=makeSessionToken();
    await pool.query('INSERT INTO customer_sessions(token_hash,customer_id,expires_at,created_at) VALUES($1,$2,NOW()+INTERVAL \'180 days\',$3)',[sessionHash(token),customer.id,now()]);
    res.json({token,user:customerPublic(customer)});
  }catch(e){res.status(500).json({error:'Unable to sign in.'});}
});
app.post('/api/auth/logout',async(req,res)=>{
  const auth=req.get('authorization')||'';
  const token=auth.startsWith('Bearer ')?auth.slice(7):'';
  if(token&&pool)await pool.query('DELETE FROM customer_sessions WHERE token_hash=$1',[sessionHash(token)]);
  res.json({ok:true});
});
app.get('/api/me',async(req,res)=>{
  try{const customer=await getCustomerBySession(req);res.json({user:customerPublic(customer)});}
  catch(e){res.status(500).json({error:'Unable to load account.'});}
});
app.get('/api/my-shipments',async(req,res)=>{
  try{
    const customer=await getCustomerBySession(req);
    if(!customer)return res.status(401).json({error:'Please sign in.'});
    const {rows}=await pool.query(`
      SELECT s.* FROM shipments s JOIN customer_tracking ct ON ct.shipment_id=s.id
      WHERE ct.customer_id=$1 ORDER BY s.created_at DESC
    `,[customer.id]);
    res.json({shipments:rows.map(rowToShipment).map(publicShipment)});
  }catch(e){res.status(500).json({error:'Unable to load shipments'});}
});
app.post('/api/support/tickets',(req,res)=>res.status(201).json({ticketId:crypto.randomUUID()}));

initDb().then(()=>{
  app.listen(PORT,'0.0.0.0',()=>console.log('Parcel Shipment API listening on '+PORT));
}).catch(err=>{
  console.error('Database initialization failed:',err);
  process.exit(1);
});
