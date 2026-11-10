# Tier List da Pelada

Site para o grupo da pelada votar depois de cada jogo. Cada um coloca os outros em **S, A, B, C ou D**, e a média dos votos vira a tier list da rodada, com a foto de todo mundo.

- Qualquer pessoa com o link se cadastra (nome, foto e uma senha de 4 números) e vota. Ninguém precisa criar conta.
- O administrador abre a votação depois do jogo, marca quem não jogou e cuida do elenco.
- Quando o último votar, a tier list sai sozinha. Dá para baixar a imagem e mandar no grupo.
- Fica o histórico de todas as rodadas e uma tier list geral com a média de cada um.

## Como colocar no ar (uma vez só, uns 15 minutos)

O site é só HTML, CSS e JavaScript, publicado pelo GitHub Pages. Os cadastros e os votos ficam no Firebase, o banco de dados do Google. O plano grátis dá e sobra para um grupo de pelada.

### 1. Criar o projeto no Firebase

1. Entre em <https://console.firebase.google.com> com uma conta Google e clique em **Criar um projeto**. Pode desligar o Google Analytics.
2. No menu da esquerda, abra **Criação › Authentication** e clique em **Vamos começar**. Na aba **Método de login**, escolha **Anônimo**, ative e salve.
3. Abra **Criação › Firestore Database** e clique em **Criar banco de dados**. Se perguntar a edição, escolha **Standard**. Escolha o local `southamerica-east1 (São Paulo)` e o **modo de produção**.
4. Ainda no Firestore, abra a aba **Regras**, apague o que estiver lá, cole todo o conteúdo do arquivo [`firestore.rules`](firestore.rules) e clique em **Publicar**.
5. Clique na engrenagem ao lado de **Visão geral do projeto** e abra **Configurações do projeto**. Em **Seus apps**, clique no ícone **`</>`** (Web), dê um nome (por exemplo `pelada`) e clique em **Registrar app**. Não precisa ativar o Firebase Hosting. Aparece um bloco `firebaseConfig` com `apiKey`, `authDomain`, `projectId` e outros valores. Deixe essa tela aberta.

### 2. Ligar o site ao Firebase

6. Aqui no GitHub, abra o arquivo [`firebase-config.js`](firebase-config.js), clique no lápis para editar e troque cada `"COLE_AQUI"` pelo valor correspondente do passo 5. Depois clique em **Commit changes**.

Esses valores podem ficar públicos: quem protege os dados são as regras do passo 4. Se o GitHub avisar ou bloquear dizendo que achou uma "Google API Key", pode liberar, porque a chave web do Firebase é feita para ficar no site.

### 3. Publicar o site

7. No repositório, vá em **Settings › Pages**. Em **Source**, escolha **Deploy from a branch**, depois a branch **main** e a pasta **/ (root)**, e salve.
8. Em um ou dois minutos o site fica em `https://<seu-usuário>.github.io/aula-branches/`. O endereço certo aparece no topo de **Settings › Pages**. Se o site ainda mostrar "Falta um passo" depois do passo 6, espere uns minutos e recarregue: o GitHub Pages demora um pouco para atualizar.

O GitHub Pages grátis só publica repositórios públicos.

### 4. Virar o administrador (antes de mandar o link)

9. Abra o site, toque em **Me cadastrar** e coloque seu nome, sua foto e uma senha de 4 números.
10. No rodapé, toque em **Área do administrador** e depois em **Virar administrador**. Só a primeira pessoa consegue, então faça isso antes de mandar o link para a galera.
11. Mande o link no grupo.

## No dia a dia

- **Depois do jogo:** o admin abre a aba **Admin**, toca em **Abrir votação** e desmarca quem não jogou.
- **A galera:** abre o link, se cadastra (só na primeira vez) e vota. Quem se cadastra com a votação aberta já entra na rodada.
- **O resultado:** quando o último votar, a tier list aparece para todo mundo. Se alguém sumir, o admin pode encerrar antes.
- **A imagem:** no resultado, toque em **Imagem da tier list** para baixar ou compartilhar.

## Perguntas

**Abri o link em outro celular ou navegador e o site não me reconhece.** Toque em **Já tenho cadastro**, escolha seu nome e digite sua senha.

**Esqueci a senha.** O admin abre a aba **Admin**, toca em **Editar** no seu nome e define uma senha nova.

**Alguém cadastrou um nome errado ou repetido.** O admin edita ou remove pela aba **Admin**.

**Quero trocar o administrador.** No Firebase, abra **Firestore Database**, entre na coleção `config` e apague o documento `setup`. Depois, quem tocar primeiro em **Virar administrador** vira o novo admin.

**Os votos são secretos?** A página nunca mostra quem votou em quem, só quantos votos de cada tier cada um recebeu. Mas os votos ficam guardados no banco, e alguém que entenda de programação conseguiria consultá-los.

**A senha de 4 números é segura?** Ela serve para ninguém votar no seu lugar por engano ou por brincadeira. Não use uma senha que você usa em outro lugar.

**Quanto custa?** Nada. O plano grátis do Firebase (Spark) aguenta dezenas de milhares de leituras por dia, e as fotos ficam no próprio banco, então não precisa ativar o Storage (que pede cartão de crédito).

## Arquivos

- `index.html`, `style.css` e `app.js`: o site.
- `firebase-config.js`: a configuração do seu projeto Firebase.
- `firestore.rules`: as regras de segurança. Cada um só mexe no próprio cadastro e no próprio voto. Só o admin abre, encerra e apaga rodadas e edita o elenco.
- `firebase.json`: só para testar no computador com os emuladores do Firebase.

### Para testar no computador

Com o [Firebase CLI](https://firebase.google.com/docs/cli) instalado (ele precisa de Java):

```sh
firebase emulators:start --project demo-pelada
```

Em outro terminal, sirva a pasta (por exemplo com `python3 -m http.server 5173 --bind 127.0.0.1`) e, no `firebase-config.js`, use `projectId: "demo-pelada"`, valores quaisquer nos outros campos e `useEmulators = true`. Abra `http://127.0.0.1:5173`. Não suba essa versão de teste para o GitHub.
