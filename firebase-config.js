// Configuração do Firebase da pelada.
//
// Onde achar estes valores: Firebase console > ícone de engrenagem > Configurações do projeto >
// Seus apps > App da Web (</>) > "Configuração do SDK" > opção "Config".
// Troque cada "COLE_AQUI" pelo valor correspondente. Esses valores podem ficar públicos:
// quem protege os dados são as regras do arquivo firestore.rules.
export const firebaseConfig = {
  apiKey: "COLE_AQUI",
  authDomain: "COLE_AQUI",
  projectId: "COLE_AQUI",
  storageBucket: "COLE_AQUI",
  messagingSenderId: "COLE_AQUI",
  appId: "COLE_AQUI",
};

// Deixe false. Só vira true para testar no computador com os emuladores do Firebase.
export const useEmulators = false;
