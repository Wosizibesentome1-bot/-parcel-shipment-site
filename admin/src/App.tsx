import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';
const request = async (method:string, path:string, body?:any) => {
  const headers:Record<string,string>={'Content-Type':'application/json'};
  const token=sessionStorage.getItem('parceltrack_admin_token'); if(token) headers['x-admin-token']=token;
  const r=await fetch(API_BASE+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const data=await r.json().catch(()=>({})); if(!r.ok) throw new Error(data.error||'Request failed'); return {data};
};
const api={get:(p:string)=>request('GET',p),post:(p:string,b:any)=>request('POST',p,b),put:(p:string,b:any)=>request('PUT',p,b),delete:(p:string)=>request('DELETE',p)};

type EventItem = {
  date: string;
  location: string;
  status: string;
};

type Shipment = {
  id: string;
  trackingNumber: string;
  customerName: string;
  customerEmail: string;
  itemDescription: string;
  carrier: string;
  origin: string;
  destination: string;
  status: string;
  eta: string;
  events: EventItem[];
  createdAt: string;
};

const emptyForm = {
  trackingNumber: '',
  customerName: '',
  customerEmail: '',
  itemDescription: '',
  carrier: 'ParcelTrack',
  origin: '',
  destination: '',
  status: 'Shipment information received',
  eta: '',
};

function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [eventForm, setEventForm] = useState({ trackingNumber: '', status: '', location: '' });
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const token = () => sessionStorage.getItem('parceltrack_admin_token') || '';

  const loadShipments = async () => {
    const response = await api.get('/api/admin/shipments', { adminToken: token() });
    setShipments(response.data.shipments ?? []);
  };

  useEffect(() => {
    const init = async () => {
      const saved = sessionStorage.getItem('parceltrack_admin_token');
      if (!saved) { setLoading(false); return; }
      try {
        const response = await api.get('/api/admin/shipments', { adminToken: saved });
        setShipments(response.data.shipments ?? []);
        setAuthenticated(true);
      } catch { sessionStorage.removeItem('parceltrack_admin_token'); }
      finally { setLoading(false); }
    };
    void init();
  }, []);

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage('');
    try {
      const response = await api.post('/api/admin/login', { password });
      sessionStorage.setItem('parceltrack_admin_token', response.data.token);
      setPassword('');
      setAuthenticated(true);
      await loadShipments();
    } catch {
      setMessage('Incorrect password.');
      setPassword('');
    }
  };

  const signOut = async () => {
    try { await api.post('/api/admin/logout', { adminToken: token() }); }
    finally {
      sessionStorage.removeItem('parceltrack_admin_token');
      setAuthenticated(false);
      setShipments([]);
    }
  };

  const openCreateForm = () => {
    setEditingId(null);
    setForm(emptyForm);
    document.getElementById('create-tracking-form')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  };

  const generateTrackingNumber = () => {
    const suffix = Math.floor(100000 + Math.random() * 900000);
    setForm(current => ({ ...current, trackingNumber: 'PT' + suffix }));
    setMessage('Tracking code generated. Complete the shipment details, then create the record.');
  };

  const submitShipment = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage('');
    try {
      if (editingId) {
        await api.put('/api/admin/shipments/' + editingId, { ...form, adminToken: token() });
        setMessage('Shipment updated.');
      } else {
        await api.post('/api/admin/shipments', { ...form, adminToken: token() });
        setMessage('Tracking number created successfully.');
      }
      setForm(emptyForm);
      setEditingId(null);
      await loadShipments();
    } catch {
      setMessage('Could not save the shipment. Check the tracking number and required fields.');
    }
  };

  const editShipment = (shipment: Shipment) => {
    setEditingId(shipment.id);
    setForm({
      trackingNumber: shipment.trackingNumber,
      customerName: shipment.customerName,
      customerEmail: shipment.customerEmail,
      itemDescription: shipment.itemDescription,
      carrier: shipment.carrier,
      origin: shipment.origin,
      destination: shipment.destination,
      status: shipment.status,
      eta: shipment.eta,
    });
    document.getElementById('create-tracking-form')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  };

  const deleteShipment = async (id: string) => {
    if (!window.confirm('Delete this tracking record?')) return;
    try {
      await api.delete('/api/admin/shipments/' + id, { adminToken: token() });
      await loadShipments();
      setMessage('Tracking record deleted.');
    } catch {
      setMessage('Could not delete the record.');
    }
  };

  const addEvent = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/admin/shipments/events', { ...eventForm, adminToken: token() });
      setEventForm({ trackingNumber: '', status: '', location: '' });
      await loadShipments();
      setMessage('Shipment update added.');
    } catch {
      setMessage('Could not add the shipment update.');
    }
  };

  const filtered = shipments.filter(shipment => {
    const q = search.toLowerCase();
    return (
      !q ||
      [shipment.trackingNumber, shipment.customerName, shipment.destination, shipment.status]
        .join(' ')
        .toLowerCase()
        .includes(q)
    );
  });

  if (loading) return <div className="center-screen">Loading admin portal…</div>;

  if (!authenticated) {
    return (
      <div className="login-shell">
        <form className="login-card" onSubmit={signIn}>
          <div className="brand-mark">PT</div>
          <p className="eyebrow">PARCELTRACK</p>
          <h1>Admin Portal</h1>
          <p className="muted">Enter the administrator password to access shipment management.</p>
          <label className="login-label">Admin password
            <input autoFocus type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter password" required />
          </label>
          <button className="primary full-width" type="submit">Log in</button>
          <p className="small">This portal is restricted to authorized administration.</p>
          {message && <div className="notice error">{message}</div>}
        </form>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">PARCELTRACK</p>
          <h1>Shipment Admin</h1>
        </div>
        <div className="user-actions">
          <button className="create-code-btn" onClick={openCreateForm}>
            + Create Tracking Code
          </button>
          <button className="secondary" onClick={() => void signOut()}>
            Log out
          </button>
        </div>
      </header>

      <main>
        {message && <div className="notice">{message}</div>}

        <section className="hero-action">
          <div>
            <p className="eyebrow">SHIPMENT MANAGEMENT</p>
            <h2>Create a customer tracking code</h2>
            <p className="muted">
              Generate a code or enter your own, then add the shipment details. The record is saved for tracking.
            </p>
          </div>
          <button className="primary create-large" onClick={openCreateForm}>
            + Create Tracking Code
          </button>
        </section>

        <section className="grid-two">
          <form className="panel create-panel" id="create-tracking-form" onSubmit={submitShipment}>
            <div className="panel-head">
              <div>
                <p className="eyebrow">{editingId ? 'EDIT RECORD' : 'NEW RECORD'}</p>
                <h2>{editingId ? 'Edit shipment' : 'Create tracking number'}</h2>
                {!editingId && (
                  <p className="muted">Complete the form below to create the tracking record.</p>
                )}
              </div>
              {editingId && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setEditingId(null);
                    setForm(emptyForm);
                  }}
                >
                  Cancel
                </button>
              )}
            </div>

            <div className="fields">
              <label>
                Tracking number
                <div className="tracking-input">
                  <input
                    required
                    value={form.trackingNumber}
                    onChange={e => setForm({ ...form, trackingNumber: e.target.value })}
                    placeholder="PT10004"
                  />
                  {!editingId && (
                    <button type="button" className="secondary generate-btn" onClick={generateTrackingNumber}>
                      Generate
                    </button>
                  )}
                </div>
              </label>
              <label>
                Customer name
                <input required value={form.customerName} onChange={e => setForm({ ...form, customerName: e.target.value })} />
              </label>
              <label>
                Customer email
                <input type="email" value={form.customerEmail} onChange={e => setForm({ ...form, customerEmail: e.target.value })} />
              </label>
              <label>
                Parcel / item description
                <input required value={form.itemDescription} onChange={e => setForm({ ...form, itemDescription: e.target.value })} />
              </label>
              <label>
                Carrier
                <input value={form.carrier} onChange={e => setForm({ ...form, carrier: e.target.value })} />
              </label>
              <label>
                Status
                <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
                  <option>Shipment information received</option>
                  <option>In transit</option>
                  <option>Arrived at facility</option>
                  <option>Out for delivery</option>
                  <option>Delivered</option>
                  <option>Exception</option>
                </select>
              </label>
              <label>
                Origin
                <input required value={form.origin} onChange={e => setForm({ ...form, origin: e.target.value })} />
              </label>
              <label>
                Destination
                <input required value={form.destination} onChange={e => setForm({ ...form, destination: e.target.value })} />
              </label>
              <label>
                Estimated delivery
                <input type="date" value={form.eta} onChange={e => setForm({ ...form, eta: e.target.value })} />
              </label>
            </div>

            <button className="primary full-width" type="submit">
              {editingId ? 'Save changes' : 'Create Tracking Code'}
            </button>
          </form>

          <form className="panel" onSubmit={addEvent}>
            <p className="eyebrow">SHIPMENT TIMELINE</p>
            <h2>Add shipment update</h2>
            <p className="muted">This update will appear in the public tracking result.</p>
            <div className="fields">
              <label>
                Tracking number
                <input required value={eventForm.trackingNumber} onChange={e => setEventForm({ ...eventForm, trackingNumber: e.target.value })} placeholder="PT10004" />
              </label>
              <label>
                Update status
                <input required value={eventForm.status} onChange={e => setEventForm({ ...eventForm, status: e.target.value })} placeholder="Departed sorting facility" />
              </label>
              <label>
                Location
                <input required value={eventForm.location} onChange={e => setEventForm({ ...eventForm, location: e.target.value })} placeholder="Toronto, ON" />
              </label>
            </div>
            <button className="primary" type="submit">Add timeline event</button>
          </form>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">TRACKING RECORDS</p>
              <h2>Manage shipments</h2>
            </div>
            <input className="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tracking or customer…" />
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tracking</th>
                  <th>Customer</th>
                  <th>Route</th>
                  <th>Status</th>
                  <th>ETA</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(shipment => (
                  <tr key={shipment.id}>
                    <td>
                      <strong>{shipment.trackingNumber}</strong>
                      <span className="sub">{shipment.itemDescription}</span>
                    </td>
                    <td>
                      {shipment.customerName}
                      <span className="sub">{shipment.customerEmail || 'No email'}</span>
                    </td>
                    <td>{shipment.origin} → {shipment.destination}</td>
                    <td>
                      <span className="badge">{shipment.status}</span>
                      <span className="sub">{shipment.events.length} updates</span>
                    </td>
                    <td>{shipment.eta || '—'}</td>
                    <td>
                      <div className="actions">
                        <button className="link-btn" onClick={() => editShipment(shipment)}>Edit</button>
                        <button className="danger" onClick={() => void deleteShipment(shipment.id)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && <div className="empty">No tracking records found.</div>}
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
