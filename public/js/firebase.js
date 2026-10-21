// Firebase app for TaskFlow (project task-flow-app-97462, web app "Task-Flow-App").
// This config is public by design; access to data is controlled by Firestore Security Rules.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyB2HFW4Udjl2yGJ4_cibhxxV0lAREseDh4',
  authDomain: 'task-flow-app-97462.firebaseapp.com',
  projectId: 'task-flow-app-97462',
  storageBucket: 'task-flow-app-97462.firebasestorage.app',
  messagingSenderId: '685374773284',
  appId: '1:685374773284:web:5ca35a109de65c4adc60b1',
  measurementId: 'G-R6QL49RLBP',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
