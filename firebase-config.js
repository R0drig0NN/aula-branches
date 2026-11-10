// Configuração do Firebase da pelada.
//
// Onde achar estes valores: Firebase console > ícone de engrenagem > Configurações do projeto >
// Seus apps > App da Web (</>) > "Configuração do SDK" > opção "Config".
// Troque cada "COLE_AQUI" pelo valor correspondente. Esses valores podem ficar públicos:
// quem protege os dados são as regras do arquivo firestore.rules.
export const firebaseConfig = {
  apiKey: "AIzaSyDuPraR0ZuRK3gvNnSMl1opPwnLUgKuX9U",
  authDomain: "corneteiro-22d45.firebaseapp.com",
  projectId: "corneteiro-22d45",
  storageBucket: "corneteiro-22d45.firebasestorage.app",
  messagingSenderId: "544397200140",
  appId: "1:544397200140:web:71307d2590f7b3b2e75729",
};

// Deixe false. Só vira true para testar no computador com os emuladores do Firebase.
export const useEmulators = false;
