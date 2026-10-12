// Schema-independent cutover/rollback target. No account writes or provider requests.
export default {
  async fetch():Promise<Response>{
    return Response.json({maintenance:true,message:'FadeLoop is paused for maintenance'},
      {status:503,headers:{'retry-after':'60','cache-control':'no-store'}});
  },
  async scheduled():Promise<void>{},
};
